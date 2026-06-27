import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCommand } from "../src/process/run-command.js";
import {
  formatProcessFailure,
  runProcessOutcome,
} from "../src/process/outcome-policy.js";
import { runTimedCommand } from "../src/process/timed-command.js";

test("runCommand captures successful stdout and stderr as utf8", async () => {
  const result = await runCommand({
    args: [
      "-e",
      "process.stdout.write('captured stdout'); process.stderr.write('captured stderr');",
    ],
    command: process.execPath,
  });

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "captured stdout");
  assert.equal(result.stderr, "captured stderr");
});

test("runCommand captures successful stdout as a buffer", async () => {
  const result = await runCommand({
    args: [
      "-e",
      "process.stdout.write(Buffer.from([0, 255, 10])); process.stderr.write('buffer stderr');",
    ],
    command: process.execPath,
    outputEncoding: "buffer",
  });

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.deepEqual([...result.stdout], [0, 255, 10]);
  assert.equal(result.stderr, "buffer stderr");
});

test("spawn errors reject runCommand and return spawn-error for runTimedCommand", async () => {
  const missingCommand = join(
    process.cwd(),
    `.missing-pushgate-command-${String(process.pid)}`,
  );

  await assert.rejects(
    runCommand({
      command: missingCommand,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT",
  );

  const timedResult = await runTimedCommand({
    args: [],
    command: missingCommand,
    cwd: process.cwd(),
    env: process.env,
    timeoutSeconds: 1,
  });

  assert.equal(timedResult.kind, "spawn-error");
  if (timedResult.kind === "spawn-error") {
    assert.equal(
      "code" in timedResult.error ? timedResult.error.code : undefined,
      "ENOENT",
    );
  }
});

test("runTimedCommand reports timeout with captured output tail", async () => {
  const result = await runTimedCommand({
    args: [
      "-e",
      [
        "process.stdout.write('stdout before timeout\\n');",
        "process.stderr.write('stderr before timeout\\n');",
        "setInterval(() => {}, 1000);",
      ].join(" "),
    ],
    command: process.execPath,
    cwd: process.cwd(),
    env: process.env,
    killGraceMs: 10,
    outputCaptureLimit: 256,
    outputTailLimit: 256,
    timeoutSeconds: 1,
  });

  assert.equal(result.kind, "timeout");
  if (result.kind === "timeout") {
    assert.equal(
      result.outputTail,
      "stdout before timeout\nstderr before timeout",
    );
  }
});

test("runTimedCommand clears stale kill timers after SIGTERM exits", async () => {
  if (process.platform === "win32") {
    return;
  }

  const started = Date.now();
  const result = await runTimedCommand({
    args: ["-e", "setInterval(() => {}, 1000);"],
    command: process.execPath,
    cwd: process.cwd(),
    env: process.env,
    killGraceMs: 4_000,
    timeoutSeconds: 1,
  });
  const elapsedMs = Date.now() - started;

  assert.equal(result.kind, "timeout");
  assert.ok(
    elapsedMs < 3_000,
    `expected timeout to settle after SIGTERM, took ${elapsedMs}ms`,
  );
});

test("runTimedCommand cleans up background descendants after completion", async () => {
  if (process.platform === "win32") {
    return;
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "pushgate-process-"));
  const grandchildPidPath = join(tempRoot, "grandchild.pid");
  const grandchildScript = [
    "const { writeFileSync } = require('node:fs');",
    "writeFileSync(process.argv[1], String(process.pid));",
    "process.on('SIGTERM', () => {});",
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const parentScript = [
    "const { existsSync } = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    "const grandchild = spawn(process.execPath, ['-e', process.argv[2], process.argv[1]], { stdio: ['ignore', 'ignore', 'ignore'] });",
    "grandchild.unref();",
    "const started = Date.now();",
    "while (!existsSync(process.argv[1]) && Date.now() - started < 1000) {}",
  ].join(" ");
  let grandchildPid: number | undefined;

  try {
    const result = await runTimedCommand({
      args: ["-e", parentScript, grandchildPidPath, grandchildScript],
      command: process.execPath,
      cwd: process.cwd(),
      env: process.env,
      timeoutSeconds: 10,
    });
    grandchildPid = Number(await readFile(grandchildPidPath, "utf8"));

    assert.equal(result.kind, "completed");
    if (result.kind === "completed") {
      assert.equal(result.code, 0);
    }
    await assertProcessIsGone(grandchildPid);
  } finally {
    if (grandchildPid !== undefined) {
      killProcessIfRunning(grandchildPid);
    }

    await rm(tempRoot, { force: true, recursive: true });
  }
});

test("runTimedCommand terminates timed-out process groups", async () => {
  if (process.platform === "win32") {
    return;
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "pushgate-process-"));
  const grandchildPidPath = join(tempRoot, "grandchild.pid");
  const grandchildScript = [
    "const { writeFileSync } = require('node:fs');",
    "writeFileSync(process.argv[1], String(process.pid));",
    "process.on('SIGTERM', () => {});",
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const parentScript = [
    "const { spawn } = require('node:child_process');",
    "const grandchild = spawn(process.execPath, ['-e', process.argv[2], process.argv[1]], { stdio: ['ignore', 'ignore', 'ignore'] });",
    "grandchild.unref();",
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const started = Date.now();

  try {
    const result = await runTimedCommand({
      args: ["-e", parentScript, grandchildPidPath, grandchildScript],
      command: process.execPath,
      cwd: process.cwd(),
      env: process.env,
      killGraceMs: 4_000,
      timeoutSeconds: 1,
    });
    const elapsedMs = Date.now() - started;
    const grandchildPid = Number(await readFile(grandchildPidPath, "utf8"));

    assert.equal(result.kind, "timeout");
    assert.ok(
      elapsedMs < 3_000,
      `expected process group cleanup before grandchild sleep finished, took ${elapsedMs}ms`,
    );
    await assertProcessIsGone(grandchildPid);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
});

test("runTimedCommand stdin broken pipes do not override close results", async () => {
  const result = await runTimedCommand({
    args: ["-e", "process.exit(0);"],
    command: process.execPath,
    cwd: process.cwd(),
    env: process.env,
    stdin: "x".repeat(4 * 1024 * 1024),
    timeoutSeconds: 1,
  });

  assert.equal(result.kind, "completed");
  if (result.kind === "completed") {
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
});

test("runTimedCommand keeps capture and output tail limits stable", async () => {
  const result = await runTimedCommand({
    args: [
      "-e",
      "process.stdout.write('stdout-123456789'); process.stderr.write('stderr-abcdef');",
    ],
    command: process.execPath,
    cwd: process.cwd(),
    env: process.env,
    outputCaptureLimit: 6,
    outputTailLimit: 8,
    timeoutSeconds: 1,
  });

  assert.equal(result.kind, "completed");
  if (result.kind === "completed") {
    assert.equal(result.stdout, "456789");
    assert.equal(result.stderr, "abcdef");
    assert.equal(result.outputTail, "9\nabcdef");
  }
});

test("process outcome policy classifies failures and formats diagnostics", async () => {
  const missingCommand = join(
    process.cwd(),
    `.missing-pushgate-outcome-command-${String(process.pid)}`,
  );

  const spawnError = await runProcessOutcome({
    args: [],
    command: missingCommand,
    cwd: process.cwd(),
    env: process.env,
    timeoutSeconds: 1,
  });

  assert.equal(spawnError.kind, "failed");
  if (spawnError.kind !== "failed") {
    assert.fail("Expected missing command to fail.");
  }
  assert.equal(spawnError.failure.kind, "spawn-error");
  assert.match(formatProcessFailure(spawnError.failure), /^failed to start:/);
  assert.match(
    formatProcessFailure(spawnError.failure, { subject: "Gitleaks" }),
    /^failed to start Gitleaks:/,
  );

  const exitCode = await runProcessOutcome({
    args: ["-e", "process.stderr.write('failure tail'); process.exit(12);"],
    command: process.execPath,
    cwd: process.cwd(),
    env: process.env,
    timeoutSeconds: 1,
  });

  assert.equal(exitCode.kind, "failed");
  if (exitCode.kind !== "failed") {
    assert.fail("Expected non-zero exit to fail.");
  }
  assert.deepEqual(exitCode.failure, { code: 12, kind: "exit-code" });
  assert.equal(exitCode.outputTail, "failure tail");
  assert.equal(formatProcessFailure(exitCode.failure), "exited with code 12");
  assert.equal(
    formatProcessFailure(exitCode.failure, { subject: "Gitleaks" }),
    "Gitleaks exited with code 12",
  );

  const signal = await runProcessOutcome({
    args: ["-e", "process.kill(process.pid, 'SIGTERM');"],
    command: process.execPath,
    cwd: process.cwd(),
    env: process.env,
    timeoutSeconds: 1,
  });

  assert.equal(signal.kind, "failed");
  if (signal.kind !== "failed") {
    assert.fail("Expected signaled command to fail.");
  }
  assert.deepEqual(signal.failure, { kind: "signal", signal: "SIGTERM" });
  assert.equal(
    formatProcessFailure(signal.failure, { subject: "Gitleaks" }),
    "Gitleaks ended by signal SIGTERM",
  );

  const timeout = await runProcessOutcome({
    args: [
      "-e",
      [
        "process.stdout.write('stdout before policy timeout\\n');",
        "process.stderr.write('stderr before policy timeout\\n');",
        "setInterval(() => {}, 1000);",
      ].join(" "),
    ],
    command: process.execPath,
    cwd: process.cwd(),
    env: process.env,
    killGraceMs: 10,
    outputTailLimit: 256,
    timeoutSeconds: 1,
  });

  assert.equal(timeout.kind, "failed");
  if (timeout.kind !== "failed") {
    assert.fail("Expected timeout to fail.");
  }
  assert.deepEqual(timeout.failure, { kind: "timeout", timeoutSeconds: 1 });
  assert.equal(
    timeout.outputTail,
    "stdout before policy timeout\nstderr before policy timeout",
  );
  assert.equal(formatProcessFailure(timeout.failure), "timed out after 1s");
});

async function assertProcessIsGone(
  pid: number,
  timeoutMs = 2_000,
): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (!processIsRunning(pid)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.fail(`expected process ${String(pid)} to be terminated`);
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) {
      return false;
    }

    throw error;
  }
}

function killProcessIfRunning(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw error;
    }
  }
}

function isMissingProcessError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ESRCH"
  );
}

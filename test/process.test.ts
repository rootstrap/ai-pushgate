import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { runCommand } from "../src/process/run-command.js";
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

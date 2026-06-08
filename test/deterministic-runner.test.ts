import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import type { PushgateConfig, ToolConfig } from "../src/config/index.js";
import type { ChangedFile } from "../src/path-policy/index.js";
import {
  expandChangedFilesToken,
  runDeterministicChecks,
} from "../src/runner/deterministic.js";

const changedFiles: ChangedFile[] = [
  {
    additions: 1,
    binary: false,
    deletions: 0,
    path: "src/file with spaces.ts",
    status: "added",
  },
  {
    additions: 2,
    binary: false,
    deletions: 1,
    path: "README.md",
    status: "modified",
  },
  {
    additions: 0,
    binary: false,
    deletions: 1,
    path: "src/deleted.ts",
    status: "deleted",
  },
];

test("expands changed files as argv entries without shell interpolation", async () => {
  await withTempDir(async (repoRoot) => {
    const recorder = await writeArgRecorder(repoRoot);
    const argsPath = join(repoRoot, "args.json");
    const output = captureOutput();

    const summary = await runDeterministicChecks(
      configWithTools([
        tool({
          command: [process.execPath, recorder, "{changed_files}"],
          extensions: [".ts"],
        }),
      ]),
      changedFiles,
      {
        env: { ...process.env, PUSHGATE_ARGS_OUT: argsPath },
        repoRoot,
        stdout: output.stream,
      },
    );

    assert.equal(summary.exitCode, 0, output.text());
    assert.deepEqual(JSON.parse(await readFile(argsPath, "utf8")), [
      "src/file with spaces.ts",
    ]);
  });
});

test("skips changed-file tools when no live scoped files match", async () => {
  await withTempDir(async (repoRoot) => {
    const recorder = await writeArgRecorder(repoRoot);
    const argsPath = join(repoRoot, "args.json");
    const output = captureOutput();

    const summary = await runDeterministicChecks(
      configWithTools([
        tool({
          command: [process.execPath, recorder, "{changed_files}"],
          extensions: [".rb"],
        }),
      ]),
      changedFiles,
      {
        env: { ...process.env, PUSHGATE_ARGS_OUT: argsPath },
        repoRoot,
        stdout: output.stream,
      },
    );

    assert.equal(summary.exitCode, 0, output.text());
    assert.equal(summary.results[0]?.status, "skipped");
    await assert.rejects(readFile(argsPath, "utf8"));
  });
});

test("runs always-mode tools even when scoped changed files are empty", async () => {
  await withTempDir(async (repoRoot) => {
    const recorder = await writeArgRecorder(repoRoot);
    const argsPath = join(repoRoot, "args.json");
    const output = captureOutput();

    const summary = await runDeterministicChecks(
      configWithTools([
        tool({
          command: [process.execPath, recorder, "{changed_files}"],
          extensions: [".rb"],
          run: "always",
        }),
      ]),
      changedFiles,
      {
        env: { ...process.env, PUSHGATE_ARGS_OUT: argsPath },
        repoRoot,
        stdout: output.stream,
      },
    );

    assert.equal(summary.exitCode, 0, output.text());
    assert.deepEqual(JSON.parse(await readFile(argsPath, "utf8")), []);
  });
});

test("blocks on blocking command failures", async () => {
  await withTempDir(async (repoRoot) => {
    const output = captureOutput();
    const summary = await runDeterministicChecks(
      configWithTools([
        tool({
          command: [
            process.execPath,
            "-e",
            "console.error('lint failed'); process.exit(2);",
          ],
        }),
      ]),
      changedFiles,
      { repoRoot, stdout: output.stream },
    );

    assert.equal(summary.exitCode, 1, output.text());
    assert.equal(summary.results[0]?.status, "blocked");
    assert.match(output.text(), /BLOCK check: exited with code 2/);
    assert.match(output.text(), /lint failed/);
    assert.match(output.text(), /git push --no-verify/);
  });
});

test("warning-mode command failures do not block", async () => {
  await withTempDir(async (repoRoot) => {
    const output = captureOutput();
    const summary = await runDeterministicChecks(
      configWithTools([
        tool({
          command: [process.execPath, "-e", "process.exit(7);"],
          mode: "warning",
        }),
      ]),
      changedFiles,
      { repoRoot, stdout: output.stream },
    );

    assert.equal(summary.exitCode, 0, output.text());
    assert.equal(summary.results[0]?.status, "warning");
    assert.match(output.text(), /WARN check: exited with code 7/);
  });
});

test("reports timeout failures deterministically", async () => {
  await withTempDir(async (repoRoot) => {
    const output = captureOutput();
    const summary = await runDeterministicChecks(
      configWithTools([
        tool({
          command: [process.execPath, "-e", "setTimeout(() => {}, 5000);"],
          timeout_seconds: 1,
        }),
      ]),
      changedFiles,
      { repoRoot, stdout: output.stream },
    );

    assert.equal(summary.exitCode, 1, output.text());
    assert.equal(summary.results[0]?.status, "blocked");
    assert.match(output.text(), /timed out after 1s/);
  });
});

test("fail_fast controls whether later tools run after blocking failures", async () => {
  await withTempDir(async (repoRoot) => {
    const recorder = await writeArgRecorder(repoRoot);
    const failFastArgsPath = join(repoRoot, "fail-fast.json");
    const aggregateArgsPath = join(repoRoot, "aggregate.json");

    const failFastSummary = await runDeterministicChecks(
      configWithTools([
        tool({ command: [process.execPath, "-e", "process.exit(1);"] }),
        tool({ command: [process.execPath, recorder] }),
      ]),
      changedFiles,
      {
        env: { ...process.env, PUSHGATE_ARGS_OUT: failFastArgsPath },
        repoRoot,
        stdout: captureOutput().stream,
      },
    );

    assert.equal(failFastSummary.exitCode, 1);
    assert.equal(failFastSummary.results.length, 1);
    await assert.rejects(readFile(failFastArgsPath, "utf8"));

    const aggregateSummary = await runDeterministicChecks(
      configWithTools([
        tool({
          command: [process.execPath, "-e", "process.exit(1);"],
          fail_fast: false,
        }),
        tool({ command: [process.execPath, recorder] }),
      ]),
      changedFiles,
      {
        env: { ...process.env, PUSHGATE_ARGS_OUT: aggregateArgsPath },
        repoRoot,
        stdout: captureOutput().stream,
      },
    );

    assert.equal(aggregateSummary.exitCode, 1);
    assert.equal(aggregateSummary.results.length, 2);
    assert.deepEqual(JSON.parse(await readFile(aggregateArgsPath, "utf8")), []);
  });
});

test("missing commands are handled according to tool mode", async () => {
  await withTempDir(async (repoRoot) => {
    const output = captureOutput();
    const summary = await runDeterministicChecks(
      configWithTools([
        tool({
          command: ["pushgate-command-that-does-not-exist"],
          mode: "warning",
        }),
      ]),
      changedFiles,
      { repoRoot, stdout: output.stream },
    );

    assert.equal(summary.exitCode, 0, output.text());
    assert.equal(summary.results[0]?.status, "warning");
    assert.match(output.text(), /failed to start/);
  });
});

test("runs built-in policies and makes warning versus blocking behavior explicit", async () => {
  await withTempDir(async (repoRoot) => {
    const output = captureOutput();
    const summary = await runDeterministicChecks(
      {
        ...configWithTools([]),
        policies: {
          diff_size: {
            max_changed_lines: 2,
            mode: "warning",
          },
          forbidden_paths: {
            patterns: ["src/**"],
            mode: "blocking",
          },
        },
      },
      changedFiles,
      { repoRoot, stdout: output.stream },
    );

    assert.equal(summary.exitCode, 1, output.text());
    assert.equal(summary.results[0]?.status, "warning");
    assert.equal(summary.results[1]?.status, "blocked");
    assert.match(output.text(), /WARN policy:diff_size/);
    assert.match(output.text(), /BLOCK policy:forbidden_paths/);
    assert.match(output.text(), /src\/file with spaces\.ts \(src\/\*\*\)/);
    assert.match(output.text(), /1 blocking failure\(s\), 1 warning\(s\)/);
  });
});

test("warning-mode built-in policy failures do not block", async () => {
  await withTempDir(async (repoRoot) => {
    const output = captureOutput();
    const summary = await runDeterministicChecks(
      {
        ...configWithTools([]),
        policies: {
          diff_size: {
            max_changed_lines: 1,
            mode: "warning",
          },
        },
      },
      changedFiles,
      { repoRoot, stdout: output.stream },
    );

    assert.equal(summary.exitCode, 0, output.text());
    assert.equal(summary.results[0]?.status, "warning");
    assert.match(output.text(), /WARN policy:diff_size/);
    assert.match(output.text(), /0 blocking failure\(s\), 1 warning\(s\)/);
  });
});

test("changed-file token expansion keeps non-token args unchanged", () => {
  assert.deepEqual(expandChangedFilesToken(["tool", "--", "{changed_files}"], [
    "a.ts",
    "b.ts",
  ]), ["tool", "--", "a.ts", "b.ts"]);
});

function configWithTools(tools: ToolConfig[]): PushgateConfig {
  return {
    version: 2,
    review: {
      target_branch: "main",
      context_lines: 10,
      max_lines_for_full_file: 300,
    },
    tools,
    policies: {},
    ai: {
      mode: "off",
      providers: {},
    },
    ignore_paths: [],
  };
}

function tool(overrides: Partial<ToolConfig> = {}): ToolConfig {
  return {
    name: "check",
    command: [process.execPath, "-e", ""],
    timeout_seconds: 60,
    mode: "blocking",
    run: "changed_files",
    fail_fast: true,
    ...overrides,
  };
}

async function withTempDir(
  callback: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const repoRoot = await mkdtemp(join(tmpdir(), "pushgate-runner-"));

  try {
    await callback(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

async function writeArgRecorder(repoRoot: string): Promise<string> {
  const scriptPath = join(repoRoot, "bin", "record-args.mjs");

  await mkdir(dirname(scriptPath), { recursive: true });
  await writeFile(
    scriptPath,
    [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.PUSHGATE_ARGS_OUT, JSON.stringify(process.argv.slice(2)));",
    ].join("\n"),
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

function captureOutput(): {
  stream: Writable;
  text(): string;
} {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });

  return {
    stream,
    text() {
      return output;
    },
  };
}

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import type {
  GitleaksPluginConfig,
  PushgateConfig,
  ToolConfig,
} from "../src/config/index.js";
import { runGit } from "../src/git/command.js";
import {
  isGitLocalEnvVar,
  sanitizeGitLocalEnv,
} from "../src/git/environment.js";
import type {
  ChangedFile,
  ChangedFileResolution,
} from "../src/path-policy/index.js";
import {
  buildDeterministicCheckPlan,
  expandChangedFilesToken,
  runDeterministicChecks,
} from "../src/runner/deterministic.js";
import { summarizeDeterministicResults } from "../src/runner/summary.js";
import { createDeterministicTranscript } from "../src/runner/transcript.js";

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

const changedFileResolution: ChangedFileResolution = {
  diffBase: "abc123",
  files: changedFiles,
  reviewRange: "def456...HEAD",
  scanRange: "pushgate-scan-range",
  targetCommit: "def456",
  targetRef: "main",
};

test("plans deterministic check count and changed-file needs in the runner module", () => {
  assert.deepEqual(
    buildDeterministicCheckPlan({
      ...configWithTools([
        tool({
          command: [process.execPath, "-e", ""],
        }),
      ]),
      policies: {
        diff_size: {
          max_changed_lines: 10,
          mode: "warning",
        },
      },
      plugins: {
        gitleaks: gitleaksPlugin(),
      },
    }),
    {
      checkCount: 3,
      needsChangedFileResolution: true,
      runChecks: true,
    },
  );
});

test("expands changed files as argv entries without shell interpolation", async () => {
  await withTempDir(async (repoRoot) => {
    const recorder = await writeArgRecorder(repoRoot);
    const argsPath = join(repoRoot, "args.json");
    const output = captureOutput();

    const summary = await runChecks(
      configWithTools([
        tool({
          command: [process.execPath, recorder, "{changed_files}"],
          extensions: [".ts"],
        }),
      ]),
      {
        env: {
          ...sanitizeGitLocalEnv(process.env),
          PUSHGATE_ARGS_OUT: argsPath,
        },
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

    const summary = await runChecks(
      configWithTools([
        tool({
          command: [process.execPath, recorder, "{changed_files}"],
          extensions: [".rb"],
        }),
      ]),
      {
        env: {
          ...sanitizeGitLocalEnv(process.env),
          PUSHGATE_ARGS_OUT: argsPath,
        },
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

    const summary = await runChecks(
      configWithTools([
        tool({
          command: [process.execPath, recorder, "{changed_files}"],
          extensions: [".rb"],
          run: "always",
        }),
      ]),
      {
        env: {
          ...sanitizeGitLocalEnv(process.env),
          PUSHGATE_ARGS_OUT: argsPath,
        },
        repoRoot,
        stdout: output.stream,
      },
    );

    assert.equal(summary.exitCode, 0, output.text());
    assert.deepEqual(JSON.parse(await readFile(argsPath, "utf8")), []);
  });
});

test("sanitizes hook-local Git env before configured tools run nested Git", async () => {
  await withTempDir(async (repoRoot) => {
    const victimRoot = join(repoRoot, "victim-repo");
    const recorder = await writeNestedGitRecorder(repoRoot);
    const resultPath = join(repoRoot, "nested-git.json");
    const output = captureOutput();

    await initGitRepo(repoRoot);
    await initGitRepo(victimRoot);

    const summary = await runChecks(
      configWithTools([
        tool({
          command: [process.execPath, recorder],
          run: "always",
        }),
      ]),
      {
        env: {
          ...sanitizeGitLocalEnv(process.env),
          ...poisonedGitEnv(victimRoot),
          PUSHGATE_NESTED_GIT_OUT: resultPath,
        },
        repoRoot,
        stdout: output.stream,
      },
    );

    assert.equal(summary.exitCode, 0, output.text());

    const recorded = JSON.parse(await readFile(resultPath, "utf8")) as {
      gitEnv: Record<string, string>;
      topLevel: string;
    };

    assert.equal(await realpath(recorded.topLevel), await realpath(repoRoot));
    assert.deepEqual(leakedGitLocalVars(recorded.gitEnv), []);
  });
});

test("blocks on blocking command failures", async () => {
  await withTempDir(async (repoRoot) => {
    const output = captureOutput();
    const summary = await runChecks(
      configWithTools([
        tool({
          command: [
            process.execPath,
            "-e",
            "console.error('lint failed'); process.exit(2);",
          ],
        }),
      ]),
      { repoRoot, stdout: output.stream },
    );

    assert.equal(summary.exitCode, 1, output.text());
    assert.equal(summary.results[0]?.status, "blocked");
    assert.match(output.text(), /\[block\] Check\s+exited with code 2/);
    assert.match(output.text(), /lint failed/);
    assert.match(output.text(), /git push --no-verify/);
  });
});

test("warning-mode command failures do not block", async () => {
  await withTempDir(async (repoRoot) => {
    const output = captureOutput();
    const summary = await runChecks(
      configWithTools([
        tool({
          command: [process.execPath, "-e", "process.exit(7);"],
          mode: "warning",
        }),
      ]),
      { repoRoot, stdout: output.stream },
    );

    assert.equal(summary.exitCode, 0, output.text());
    assert.equal(summary.results[0]?.status, "warning");
    assert.match(output.text(), /\[warn\] Check\s+exited with code 7/);
  });
});

test("reports timeout failures deterministically", async () => {
  await withTempDir(async (repoRoot) => {
    const output = captureOutput();
    const summary = await runChecks(
      configWithTools([
        tool({
          command: [process.execPath, "-e", "setTimeout(() => {}, 5000);"],
          timeout_seconds: 1,
        }),
      ]),
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

    const failFastSummary = await runChecks(
      configWithTools([
        tool({ command: [process.execPath, "-e", "process.exit(1);"] }),
        tool({ command: [process.execPath, recorder] }),
      ]),
      {
        env: {
          ...sanitizeGitLocalEnv(process.env),
          PUSHGATE_ARGS_OUT: failFastArgsPath,
        },
        repoRoot,
        stdout: captureOutput().stream,
      },
    );

    assert.equal(failFastSummary.exitCode, 1);
    assert.equal(failFastSummary.results.length, 1);
    await assert.rejects(readFile(failFastArgsPath, "utf8"));

    const aggregateSummary = await runChecks(
      configWithTools([
        tool({
          command: [process.execPath, "-e", "process.exit(1);"],
          fail_fast: false,
        }),
        tool({ command: [process.execPath, recorder] }),
      ]),
      {
        env: {
          ...sanitizeGitLocalEnv(process.env),
          PUSHGATE_ARGS_OUT: aggregateArgsPath,
        },
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
    const summary = await runChecks(
      configWithTools([
        tool({
          command: ["pushgate-command-that-does-not-exist"],
          mode: "warning",
        }),
      ]),
      { repoRoot, stdout: output.stream },
    );

    assert.equal(summary.exitCode, 0, output.text());
    assert.equal(summary.results[0]?.status, "warning");
    assert.match(output.text(), /failed to start/);
  });
});

test("runs Gitleaks plugin over the resolved branch commit range", async () => {
  await withTempDir(async (repoRoot) => {
    const gitleaks = await writeGitleaksStub(repoRoot);
    const argsPath = join(repoRoot, "gitleaks-args.json");
    const output = captureOutput();
    const summary = await runChecks(
      {
        ...configWithTools([]),
        plugins: {
          gitleaks: gitleaksPlugin({ command: gitleaks }),
        },
      },
      {
        env: {
          ...sanitizeGitLocalEnv(process.env),
          PUSHGATE_GITLEAKS_ARGS_OUT: argsPath,
          PUSHGATE_GITLEAKS_EXIT_CODE: "1",
          PUSHGATE_GITLEAKS_REPORT: JSON.stringify([
            {
              File: "src/config.ts",
              RuleID: "generic-api-key",
              StartLine: 3,
            },
          ]),
        },
        repoRoot,
        stdout: output.stream,
      },
    );

    assert.equal(summary.exitCode, 1, output.text());
    assert.equal(summary.results[0]?.status, "blocked");
    assert.match(output.text(), /\[block\] Secrets scan/);
    assert.match(output.text(), /src\/config\.ts:3 \(generic-api-key\)/);

    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    assert.equal(args[0], "git");
    assert.ok(args.includes("--redact"));
    assert.equal(args[args.indexOf("--report-format") + 1], "json");
    assert.equal(args[args.indexOf("--log-opts") + 1], "pushgate-scan-range");
    assert.equal(args.at(-1), repoRoot);
  });
});

test("sanitizes hook-local Git env before Gitleaks plugin commands", async () => {
  await withTempDir(async (repoRoot) => {
    const victimRoot = join(repoRoot, "victim-repo");
    const gitleaks = await writeGitleaksStub(repoRoot);
    const envPath = join(repoRoot, "gitleaks-env.json");
    const output = captureOutput();

    await initGitRepo(victimRoot);

    const summary = await runChecks(
      {
        ...configWithTools([]),
        plugins: {
          gitleaks: gitleaksPlugin({ command: gitleaks }),
        },
      },
      {
        env: {
          ...sanitizeGitLocalEnv(process.env),
          ...poisonedGitEnv(victimRoot),
          PUSHGATE_GITLEAKS_ENV_OUT: envPath,
        },
        repoRoot,
        stdout: output.stream,
      },
    );

    assert.equal(summary.exitCode, 0, output.text());

    const recorded = JSON.parse(await readFile(envPath, "utf8")) as Record<
      string,
      string
    >;

    assert.deepEqual(leakedGitLocalVars(recorded), []);
  });
});

test("warning-mode Gitleaks findings do not stop later tools", async () => {
  await withTempDir(async (repoRoot) => {
    const gitleaks = await writeGitleaksStub(repoRoot);
    const recorder = await writeArgRecorder(repoRoot);
    const argsPath = join(repoRoot, "tool-args.json");
    const output = captureOutput();
    const summary = await runChecks(
      {
        ...configWithTools([
          tool({
            command: [process.execPath, recorder],
          }),
        ]),
        plugins: {
          gitleaks: gitleaksPlugin({
            command: gitleaks,
            mode: "warning",
          }),
        },
      },
      {
        env: {
          ...sanitizeGitLocalEnv(process.env),
          PUSHGATE_ARGS_OUT: argsPath,
          PUSHGATE_GITLEAKS_EXIT_CODE: "1",
          PUSHGATE_GITLEAKS_REPORT: JSON.stringify([
            {
              File: "README.md",
              RuleID: "generic-api-key",
              StartLine: 1,
            },
          ]),
        },
        repoRoot,
        stdout: output.stream,
      },
    );

    assert.equal(summary.exitCode, 0, output.text());
    assert.deepEqual(
      summary.results.map((result) => result.status),
      ["warning", "passed"],
    );
    assert.deepEqual(JSON.parse(await readFile(argsPath, "utf8")), []);
    assert.match(output.text(), /\[warn\] Secrets scan/);
    assert.match(output.text(), /\[ok\] Check/);
  });
});

test("runs built-in policies and makes warning versus blocking behavior explicit", async () => {
  await withTempDir(async (repoRoot) => {
    const output = captureOutput();
    const summary = await runChecks(
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
      { repoRoot, stdout: output.stream },
    );

    assert.equal(summary.exitCode, 1, output.text());
    assert.equal(summary.results[0]?.status, "warning");
    assert.equal(summary.results[1]?.status, "blocked");
    assert.match(output.text(), /\[warn\] Diff size/);
    assert.match(output.text(), /\[block\] Forbidden paths/);
    assert.match(output.text(), /src\/file with spaces\.ts \(src\/\*\*\)/);
    assert.match(output.text(), /1 blocking failure and 1 warning/);
  });
});

test("warning-mode built-in policy failures do not block", async () => {
  await withTempDir(async (repoRoot) => {
    const output = captureOutput();
    const summary = await runChecks(
      {
        ...configWithTools([]),
        policies: {
          diff_size: {
            max_changed_lines: 1,
            mode: "warning",
          },
        },
      },
      { repoRoot, stdout: output.stream },
    );

    assert.equal(summary.exitCode, 0, output.text());
    assert.equal(summary.results[0]?.status, "warning");
    assert.match(output.text(), /\[warn\] Diff size/);
    assert.match(output.text(), /1 non-blocking warning/);
  });
});

test("changed-file token expansion keeps non-token args unchanged", () => {
  assert.deepEqual(expandChangedFilesToken(["tool", "--", "{changed_files}"], [
    "a.ts",
    "b.ts",
  ]), ["tool", "--", "a.ts", "b.ts"]);
});

test("summarizes deterministic result counts and exit code", () => {
  assert.deepEqual(
    summarizeDeterministicResults([
      { name: "format", status: "passed" },
      { name: "lint", status: "warning" },
      { name: "test", status: "blocked" },
      { name: "types", status: "skipped" },
    ]),
    {
      blockedCount: 1,
      exitCode: 1,
      warningCount: 1,
    },
  );

  assert.deepEqual(
    summarizeDeterministicResults([
      { name: "format", status: "passed" },
      { name: "lint", status: "warning" },
    ]),
    {
      blockedCount: 0,
      exitCode: 0,
      warningCount: 1,
    },
  );
});

test("renders deterministic transcript without running commands", () => {
  const output = captureOutput();
  const transcript = createDeterministicTranscript(output.stream);

  transcript.writeStart(3);
  transcript.writePolicyResult({
    name: "policy:diff_size",
    status: "passed",
    detail: "5 changed line(s) within max_changed_lines 10",
  });
  transcript.writeToolResult(tool(), {
    name: "check",
    status: "blocked",
    detail: "exited with code 2",
    outputTail: "first line\nsecond line",
  });
  transcript.writeFailFast();
  transcript.writeSummary({
    blockedCount: 1,
    exitCode: 1,
    warningCount: 0,
  });

  assert.equal(
    output.text(),
    [
      "Checks",
      "  Running 3 checks.",
      "  [ok] Diff size          5 / 10 changed lines",
      "  [block] Check              exited with code 2",
      "  Command output:",
      "    first line",
      "    second line",
      "  Stopped after a blocking failure because fail_fast is true.",
      "",
      "Checks completed with 1 blocking failure and 0 warnings.",
      "",
      "Blocked",
      "  Check failed and is configured as a blocking check.",
      "",
      "Fix the blocking failures above, or use `git push --no-verify` only when you intend to bypass local hooks.",
      "",
    ].join("\n"),
  );
});

async function runChecks(
  config: PushgateConfig,
  options: Omit<
    Parameters<typeof runDeterministicChecks>[0],
    "config"
  > = {},
) {
  return await runDeterministicChecks({
    changedFileResolution,
    ...options,
    config,
  });
}

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
    plugins: {},
    ai: {
      mode: "off",
      max_changed_lines: 500,
      max_prompt_tokens: 12_000,
      timeout_seconds: 120,
      providers: {},
    },
    ignore_paths: [],
  };
}

function gitleaksPlugin(
  overrides: Partial<GitleaksPluginConfig> = {},
): GitleaksPluginConfig {
  return {
    enabled: true,
    command: "gitleaks",
    timeout_seconds: 60,
    mode: "blocking",
    fail_fast: true,
    redact: true,
    ...overrides,
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

async function writeGitleaksStub(repoRoot: string): Promise<string> {
  const scriptPath = join(repoRoot, "bin", "gitleaks-stub.mjs");

  await mkdir(dirname(scriptPath), { recursive: true });
  await writeFile(
    scriptPath,
    [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "if (process.env.PUSHGATE_GITLEAKS_ARGS_OUT) {",
      "  writeFileSync(process.env.PUSHGATE_GITLEAKS_ARGS_OUT, JSON.stringify(args));",
      "}",
      "if (process.env.PUSHGATE_GITLEAKS_ENV_OUT) {",
      "  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('GIT_')));",
      "  writeFileSync(process.env.PUSHGATE_GITLEAKS_ENV_OUT, JSON.stringify(gitEnv));",
      "}",
      "const reportPath = args[args.indexOf('--report-path') + 1];",
      "if (reportPath && process.env.PUSHGATE_GITLEAKS_REPORT) {",
      "  writeFileSync(reportPath, process.env.PUSHGATE_GITLEAKS_REPORT);",
      "}",
      "process.exit(Number(process.env.PUSHGATE_GITLEAKS_EXIT_CODE ?? '0'));",
    ].join("\n"),
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function writeNestedGitRecorder(repoRoot: string): Promise<string> {
  const scriptPath = join(repoRoot, "bin", "record-nested-git.mjs");

  await mkdir(dirname(scriptPath), { recursive: true });
  await writeFile(
    scriptPath,
    [
      "import { execFileSync } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();",
      "const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('GIT_')));",
      "writeFileSync(process.env.PUSHGATE_NESTED_GIT_OUT, JSON.stringify({ gitEnv, topLevel }));",
    ].join("\n"),
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function initGitRepo(repoRoot: string): Promise<void> {
  await mkdir(repoRoot, { recursive: true });
  await checkedGit(repoRoot, ["init", "--quiet", "--initial-branch=main"]);
}

async function checkedGit(repoRoot: string, args: string[]): Promise<void> {
  const result = await runGit(repoRoot, args, {
    env: sanitizeGitLocalEnv(process.env),
  });

  if (result.code !== 0) {
    throw new Error(
      [
        `git ${args.join(" ")} exited with ${String(result.code)}.`,
        `stdout:\n${result.stdout}`,
        `stderr:\n${result.stderr}`,
      ].join("\n"),
    );
  }
}

function poisonedGitEnv(victimRoot: string): NodeJS.ProcessEnv {
  return {
    GIT_COMMON_DIR: join(victimRoot, ".git"),
    GIT_CONFIG: join(victimRoot, ".git", "config"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.bare",
    GIT_CONFIG_VALUE_0: "true",
    GIT_DIR: join(victimRoot, ".git"),
    GIT_INDEX_FILE: join(victimRoot, ".git", "index"),
    GIT_WORK_TREE: victimRoot,
  };
}

function leakedGitLocalVars(env: Record<string, string>): string[] {
  return Object.keys(env).filter(isGitLocalEnvVar).sort();
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

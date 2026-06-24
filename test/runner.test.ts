import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runnerSourcePath = fileURLToPath(
  new URL("../bin/pushgate.mjs", import.meta.url),
);

test("prints the hook protocol for thin hook compatibility checks", async () => {
  const result = await runRunner(["hook-protocol"]);

  assert.equal(result.code, 0, formatResult(result));
  assert.equal(result.stdout, "1\n");
  assert.equal(result.stderr, "");
});

test("accepts pre-push args and drains Git hook stdin", async () => {
  await withRunnerRepo(async (repoRoot) => {
    const result = await runRunner(
      ["pre-push", "origin", "git@example.test:rootstrap/ai-pushgate.git"],
      "refs/heads/feature local refs/heads/feature remote\n",
      { cwd: repoRoot },
    );

    assert.equal(result.code, 0, formatResult(result));
    assert.match(result.stdout, /No deterministic checks configured/);
    assert.equal(result.stderr, "");
  });
});

test("fails unsupported command shapes with usage output", async () => {
  const result = await runRunner(["hook-protocol", "extra"]);

  assert.equal(result.code, 64, formatResult(result));
  assert.match(result.stderr, /hook-protocol does not accept arguments/);
  assert.match(result.stderr, /Usage:/);
});

test("fails unsupported subcommands with usage output", async () => {
  const result = await runRunner(["review"]);

  assert.equal(result.code, 64, formatResult(result));
  assert.match(result.stderr, /Unsupported Pushgate command: review/);
  assert.match(result.stderr, /Usage:/);
});

test("runs built-in policies against resolved pre-push changed files", async () => {
  await withPolicyRepo(async (repoRoot) => {
    const result = await runRunner(
      ["pre-push", "origin", "git@example.test:rootstrap/ai-pushgate.git"],
      "refs/heads/feature local refs/heads/feature remote\n",
      { cwd: repoRoot },
    );

    assert.equal(result.code, 1, formatResult(result));
    assert.match(result.stdout, /Running 2 deterministic check\(s\)/);
    assert.match(result.stdout, /WARN policy:diff_size/);
    assert.match(result.stdout, /3 changed line\(s\) exceed max_changed_lines 2/);
    assert.match(result.stdout, /BLOCK policy:forbidden_paths/);
    assert.match(result.stdout, /secrets\/token\.txt \(secrets\/\*\*\)/);
    assert.match(result.stdout, /1 blocking failure\(s\), 1 warning\(s\)/);
    assert.equal(result.stderr, "");
  });
});

test("Gitleaks plugin findings block the pre-push runner", async () => {
  await withGitleaksRepo(async (repoRoot, env) => {
    const result = await runRunner(
      ["pre-push", "origin", "git@example.test:rootstrap/ai-pushgate.git"],
      "refs/heads/feature local refs/heads/feature remote\n",
      { cwd: repoRoot, env },
    );

    assert.equal(result.code, 1, formatResult(result));
    assert.match(result.stdout, /Running 1 deterministic check\(s\)/);
    assert.match(result.stdout, /BLOCK plugin:gitleaks/);
    assert.match(result.stdout, /src\/secret\.txt:1 \(generic-api-key\)/);
    assert.doesNotMatch(result.stdout, /Running local AI review/);
    assert.equal(result.stderr, "");
  });
});

test("skip-all-checks bypasses config loading and deterministic work", async () => {
  await withGitRepo(async (repoRoot) => {
    await checkedRun("git", ["config", "pushgate.skip-all-checks", "true"], {
      cwd: repoRoot,
    });

    const result = await runRunner(
      ["pre-push", "origin", "git@example.test:rootstrap/ai-pushgate.git"],
      "refs/heads/feature local refs/heads/feature remote\n",
      { cwd: repoRoot },
    );

    assert.equal(result.code, 0, formatResult(result));
    assert.match(
      result.stdout,
      /Skipping all local Pushgate checks because pushgate\.skip-all-checks=true/,
    );
    assert.equal(result.stderr, "");
  });
});

test("skip-ai-check keeps deterministic work and prints visible AI skip output", async () => {
  await withGitRepo(async (repoRoot) => {
    await writeFile(
      join(repoRoot, ".pushgate.yml"),
      [
        "version: 2",
        "ai:",
        "  mode: blocking",
        "  provider: claude",
        "  providers:",
        "    claude: {}",
        "tools: []",
        "",
      ].join("\n"),
    );
    await checkedRun("git", ["config", "pushgate.skip-ai-check", "true"], {
      cwd: repoRoot,
    });

    const result = await runRunner(
      ["pre-push", "origin", "git@example.test:rootstrap/ai-pushgate.git"],
      "refs/heads/feature local refs/heads/feature remote\n",
      { cwd: repoRoot },
    );

    assert.equal(result.code, 0, formatResult(result));
    assert.match(result.stdout, /No deterministic checks configured/);
    assert.match(
      result.stdout,
      /Skipping local AI because pushgate\.skip-ai-check=true/,
    );
    assert.equal(result.stderr, "");
  });
});

test("blocking local AI findings block the pre-push runner", async () => {
  await withAiRepo(async (repoRoot, env) => {
    await writeFile(
      join(repoRoot, ".pushgate.yml"),
      [
        "version: 2",
        "ai:",
        "  mode: blocking",
        "  provider: claude",
        "  providers:",
        "    claude:",
        "      model: claude-sonnet-4-20250514",
        "tools: []",
        "",
      ].join("\n"),
    );

    const result = await runRunner(
      ["pre-push", "origin", "git@example.test:rootstrap/ai-pushgate.git"],
      "refs/heads/feature local refs/heads/feature remote\n",
      { cwd: repoRoot, env },
    );

    assert.equal(result.code, 1, formatResult(result));
    assert.match(result.stdout, /Running local AI review with claude/);
    assert.match(result.stdout, /BLOCK AI logic_errors at src\/changed\.ts:2-3/);
    assert.match(result.stdout, /Local AI review blocked the push/);
    assert.equal(result.stderr, "");
  });
});

test("Copilot local AI findings flow through the pre-push runner", async () => {
  await withAiRepo(async (repoRoot, env) => {
    await installCopilotStub(join(repoRoot, "bin"));
    await writeFile(
      join(repoRoot, ".pushgate.yml"),
      [
        "version: 2",
        "ai:",
        "  mode: blocking",
        "  provider: copilot",
        "  providers:",
        "    copilot:",
        "      model: auto",
        "tools: []",
        "",
      ].join("\n"),
    );

    const result = await runRunner(
      ["pre-push", "origin", "git@example.test:rootstrap/ai-pushgate.git"],
      "refs/heads/feature local refs/heads/feature remote\n",
      { cwd: repoRoot, env },
    );

    assert.equal(result.code, 0, formatResult(result));
    assert.match(result.stdout, /Running local AI review with copilot/);
    assert.match(result.stdout, /WARN AI performance at src\/changed\.ts:2/);
    assert.match(
      result.stdout,
      /Local AI review finished: 0 blocking finding\(s\), 1 warning\(s\)/,
    );
    assert.equal(result.stderr, "");
  });
});

test("blocking local AI provider failures block the pre-push runner", async () => {
  await withAiRepo(async (repoRoot) => {
    await writeFile(
      join(repoRoot, ".pushgate.yml"),
      [
        "version: 2",
        "ai:",
        "  mode: blocking",
        "  provider: claude",
        "  providers:",
        "    claude: {}",
        "tools: []",
        "",
      ].join("\n"),
    );

    const result = await runRunner(
      ["pre-push", "origin", "git@example.test:rootstrap/ai-pushgate.git"],
      "refs/heads/feature local refs/heads/feature remote\n",
      { cwd: repoRoot },
    );

    assert.equal(result.code, 1, formatResult(result));
    assert.match(
      result.stdout,
      /BLOCK local AI provider claude failed: Claude Code CLI was not found on PATH/,
    );
    assert.match(result.stdout, /Local AI is blocking in this repository/);
    assert.equal(result.stderr, "");
  });
});

test("default local AI mode is blocking in the pre-push runner", async () => {
  await withAiRepo(async (repoRoot) => {
    await writeFile(
      join(repoRoot, ".pushgate.yml"),
      [
        "version: 2",
        "ai:",
        "  provider: claude",
        "  providers:",
        "    claude: {}",
        "tools: []",
        "",
      ].join("\n"),
    );

    const result = await runRunner(
      ["pre-push", "origin", "git@example.test:rootstrap/ai-pushgate.git"],
      "refs/heads/feature local refs/heads/feature remote\n",
      { cwd: repoRoot },
    );

    assert.equal(result.code, 1, formatResult(result));
    assert.match(
      result.stdout,
      /BLOCK local AI provider claude failed: Claude Code CLI was not found on PATH/,
    );
    assert.equal(result.stderr, "");
  });
});

test("advisory local AI provider failures do not block the pre-push runner", async () => {
  await withAiRepo(async (repoRoot) => {
    await writeFile(
      join(repoRoot, ".pushgate.yml"),
      [
        "version: 2",
        "ai:",
        "  mode: advisory",
        "  provider: claude",
        "  providers:",
        "    claude: {}",
        "tools: []",
        "",
      ].join("\n"),
    );

    const result = await runRunner(
      ["pre-push", "origin", "git@example.test:rootstrap/ai-pushgate.git"],
      "refs/heads/feature local refs/heads/feature remote\n",
      { cwd: repoRoot },
    );

    assert.equal(result.code, 0, formatResult(result));
    assert.match(
      result.stdout,
      /WARN local AI provider claude failed: Claude Code CLI was not found on PATH/,
    );
    assert.match(result.stdout, /Continuing because ai.mode is advisory/);
    assert.equal(result.stderr, "");
  });
});

test("AI changed-line guardrail skips provider invocation visibly", async () => {
  await withAiRepo(async (repoRoot, env) => {
    await writeFile(
      join(repoRoot, ".pushgate.yml"),
      [
        "version: 2",
        "ai:",
        "  mode: blocking",
        "  max_changed_lines: 1",
        "  provider: claude",
        "  providers:",
        "    claude: {}",
        "tools: []",
        "",
      ].join("\n"),
    );

    const result = await runRunner(
      ["pre-push", "origin", "git@example.test:rootstrap/ai-pushgate.git"],
      "refs/heads/feature local refs/heads/feature remote\n",
      { cwd: repoRoot, env },
    );

    assert.equal(result.code, 0, formatResult(result));
    assert.match(
      result.stdout,
      /Skipping local AI because \d+ changed line\(s\) exceed ai\.max_changed_lines 1/,
    );
    assert.doesNotMatch(result.stdout, /Running local AI review with claude/);
    assert.equal(result.stderr, "");
  });
});

test("push wrapper maps skip-all-checks to one-command Git config", async () => {
  await withGitStub(async ({ argsPath, env, root }) => {
    const result = await runRunner(
      ["push", "--skip-all-checks", "origin", "feature"],
      undefined,
      { cwd: root, env },
    );

    assert.equal(result.code, 23, formatResult(result));
    assert.deepEqual(await readArgLines(argsPath), [
      "-c",
      "pushgate.skip-all-checks=true",
      "push",
      "origin",
      "feature",
    ]);
  });
});

test("push wrapper maps skip-ai-check to one-command Git config", async () => {
  await withGitStub(async ({ argsPath, env, root }) => {
    const result = await runRunner(
      ["push", "--skip-ai-check", "origin", "feature"],
      undefined,
      { cwd: root, env },
    );

    assert.equal(result.code, 23, formatResult(result));
    assert.deepEqual(await readArgLines(argsPath), [
      "-c",
      "pushgate.skip-ai-check=true",
      "push",
      "origin",
      "feature",
    ]);
  });
});

test("push wrapper keeps skip-all precedence when both wrapper flags are present", async () => {
  await withGitStub(async ({ argsPath, env, root }) => {
    const result = await runRunner(
      ["push", "--skip-ai-check", "--skip-all-checks", "origin", "feature"],
      undefined,
      { cwd: root, env },
    );

    assert.equal(result.code, 23, formatResult(result));
    assert.deepEqual(await readArgLines(argsPath), [
      "-c",
      "pushgate.skip-all-checks=true",
      "push",
      "origin",
      "feature",
    ]);
  });
});

test("push wrapper forwards Git args after -- without interpreting them as Pushgate flags", async () => {
  await withGitStub(async ({ argsPath, env, root }) => {
    const result = await runRunner(
      ["push", "--", "--skip-ai-check", "origin", "feature"],
      undefined,
      { cwd: root, env },
    );

    assert.equal(result.code, 23, formatResult(result));
    assert.deepEqual(await readArgLines(argsPath), [
      "push",
      "--",
      "--skip-ai-check",
      "origin",
      "feature",
    ]);
  });
});

interface RunnerResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

interface RunRunnerOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

function runRunner(
  args: string[],
  stdin?: string,
  options: RunRunnerOptions = {},
): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerSourcePath, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";

    if (!child.stdout || !child.stderr) {
      reject(new Error("Runner tests must capture stdout and stderr."));
      return;
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      stdout += data;
    });
    child.stderr.on("data", (data: string) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stderr, stdout });
    });

    if (stdin !== undefined) {
      if (!child.stdin) {
        reject(new Error("Runner stdin was not piped."));
        return;
      }

      child.stdin.end(stdin);
    }
  });
}

async function withRunnerRepo(
  callback: (repoRoot: string) => Promise<void>,
): Promise<void> {
  await withGitRepo(async (repoRoot) => {
    await writeFile(
      join(repoRoot, ".pushgate.yml"),
      "version: 2\nai:\n  mode: off\ntools: []\n",
    );
    await callback(repoRoot);
  });
}

async function withGitRepo(
  callback: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const repoRoot = await mkdtemp(join(tmpdir(), "pushgate-cli-"));

  try {
    await checkedRun("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: repoRoot,
    });
    await callback(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

async function withPolicyRepo(
  callback: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const repoRoot = await mkdtemp(join(tmpdir(), "pushgate-policy-cli-"));

  try {
    await checkedRun("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: repoRoot,
    });
    await checkedRun("git", ["config", "user.email", "runner@example.test"], {
      cwd: repoRoot,
    });
    await checkedRun("git", ["config", "user.name", "Pushgate Runner"], {
      cwd: repoRoot,
    });
    await writeRepoFile(
      repoRoot,
      ".pushgate.yml",
      [
        "version: 2",
        "ai:",
        "  mode: off",
        "tools: []",
        "policies:",
        "  diff_size:",
        "    max_changed_lines: 2",
        "    mode: warning",
        "  forbidden_paths:",
        "    patterns:",
        "      - secrets/**",
        "    mode: blocking",
        "",
      ].join("\n"),
    );
    await writeRepoFile(repoRoot, "README.md", "base\n");
    await checkedRun("git", ["add", "--all"], { cwd: repoRoot });
    await checkedRun("git", ["commit", "--quiet", "-m", "baseline"], {
      cwd: repoRoot,
    });
    await checkedRun("git", ["switch", "--quiet", "-c", "feature"], {
      cwd: repoRoot,
    });
    await writeRepoFile(repoRoot, "README.md", "base\nfeature\nmore\n");
    await writeRepoFile(repoRoot, "secrets/token.txt", "secret\n");
    await checkedRun("git", ["add", "--all"], { cwd: repoRoot });
    await checkedRun("git", ["commit", "--quiet", "-m", "feature"], {
      cwd: repoRoot,
    });

    await callback(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

async function withGitleaksRepo(
  callback: (repoRoot: string, env: NodeJS.ProcessEnv) => Promise<void>,
): Promise<void> {
  const repoRoot = await mkdtemp(join(tmpdir(), "pushgate-gitleaks-cli-"));
  const binDir = join(repoRoot, "bin");

  try {
    await mkdir(binDir, { recursive: true });
    await checkedRun("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: repoRoot,
    });
    await checkedRun("git", ["config", "user.email", "runner@example.test"], {
      cwd: repoRoot,
    });
    await checkedRun("git", ["config", "user.name", "Pushgate Runner"], {
      cwd: repoRoot,
    });
    await writeRepoFile(
      repoRoot,
      ".pushgate.yml",
      [
        "version: 2",
        "ai:",
        "  mode: off",
        "tools: []",
        "plugins:",
        "  gitleaks:",
        "    command: gitleaks",
        "",
      ].join("\n"),
    );
    await writeRepoFile(repoRoot, "README.md", "base\n");
    await checkedRun("git", ["add", "--all"], { cwd: repoRoot });
    await checkedRun("git", ["commit", "--quiet", "-m", "baseline"], {
      cwd: repoRoot,
    });
    await checkedRun("git", ["switch", "--quiet", "-c", "feature"], {
      cwd: repoRoot,
    });
    await writeRepoFile(repoRoot, "src/secret.txt", "token\n");
    await checkedRun("git", ["add", "--all"], { cwd: repoRoot });
    await checkedRun("git", ["commit", "--quiet", "-m", "feature"], {
      cwd: repoRoot,
    });
    await installGitleaksStub(binDir);

    await callback(repoRoot, {
      ...process.env,
      PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
    });
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

async function withAiRepo(
  callback: (repoRoot: string, env: NodeJS.ProcessEnv) => Promise<void>,
): Promise<void> {
  const repoRoot = await mkdtemp(join(tmpdir(), "pushgate-ai-cli-"));
  const binDir = join(repoRoot, "bin");

  try {
    await mkdir(binDir, { recursive: true });
    await checkedRun("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: repoRoot,
    });
    await checkedRun("git", ["config", "user.email", "runner@example.test"], {
      cwd: repoRoot,
    });
    await checkedRun("git", ["config", "user.name", "Pushgate Runner"], {
      cwd: repoRoot,
    });
    await writeRepoFile(repoRoot, "src/changed.ts", "export const base = true;\n");
    await checkedRun("git", ["add", "--all"], { cwd: repoRoot });
    await checkedRun("git", ["commit", "--quiet", "-m", "baseline"], {
      cwd: repoRoot,
    });
    await checkedRun("git", ["switch", "--quiet", "-c", "feature"], {
      cwd: repoRoot,
    });
    await writeRepoFile(
      repoRoot,
      "src/changed.ts",
      [
        "export function changed(flag) {",
        "  if (flag) {",
        "    return false;",
        "  }",
        "  return flag;",
        "}",
        "",
      ].join("\n"),
    );
    await checkedRun("git", ["add", "--all"], { cwd: repoRoot });
    await checkedRun("git", ["commit", "--quiet", "-m", "feature"], {
      cwd: repoRoot,
    });
    await installClaudeStub(binDir);

    await callback(repoRoot, {
      ...process.env,
      PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
    });
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

async function writeRepoFile(
  repoRoot: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const filePath = join(repoRoot, relativePath);

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

async function installClaudeStub(binDir: string): Promise<void> {
  await writeFile(
    join(binDir, "claude"),
    [
      "#!/usr/bin/env bash",
      "set -eu",
      "cat > /dev/null",
      "cat <<'EOF'",
      claudeStructuredOutputJson({
        schema_version: 1,
        findings: [
          {
            category: "logic_errors",
            confidence: "high",
            severity: "blocking",
            file: "src/changed.ts",
            line: "2-3",
            message:
              "The true branch always returns false instead of preserving the flag.",
            suggestion:
              "Return the computed value for the true branch and cover it with a regression test.",
          },
        ],
      }),
      "EOF",
    ].join("\n"),
  );
  await chmod(join(binDir, "claude"), 0o755);
}

async function installCopilotStub(binDir: string): Promise<void> {
  await writeFile(
    join(binDir, "copilot"),
    [
      "#!/usr/bin/env bash",
      "set -eu",
      "cat > /dev/null",
      "cat <<'EOF'",
      copilotAssistantMessageJsonl(
        "{\"schema_version\":1,\"findings\":[{\"category\":\"performance\",\"confidence\":\"medium\",\"severity\":\"warning\",\"file\":\"src/changed.ts\",\"line\":\"2\",\"message\":\"The changed branch repeats avoidable work.\",\"suggestion\":\"Cache the computed result before returning.\"}]}",
      ),
      "EOF",
    ].join("\n"),
  );
  await chmod(join(binDir, "copilot"), 0o755);
}

function copilotAssistantMessageJsonl(content: string): string {
  return JSON.stringify({
    type: "assistant.message",
    data: {
      messageId: "msg-1",
      phase: "response",
      content,
    },
  });
}

function claudeStructuredOutputJson(structuredOutput: unknown): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    structured_output: structuredOutput,
  });
}

async function installGitleaksStub(binDir: string): Promise<void> {
  await writeFile(
    join(binDir, "gitleaks"),
    [
      "#!/usr/bin/env bash",
      "set -eu",
      "report_path=''",
      "previous=''",
      "for arg in \"$@\"; do",
      "  if [ \"$previous\" = '--report-path' ]; then",
      "    report_path=\"$arg\"",
      "  fi",
      "  previous=\"$arg\"",
      "done",
      "printf '%s' '[{\"File\":\"src/secret.txt\",\"RuleID\":\"generic-api-key\",\"StartLine\":1}]' > \"$report_path\"",
      "exit 1",
    ].join("\n"),
  );
  await chmod(join(binDir, "gitleaks"), 0o755);
}

interface CommandOptions {
  cwd: string;
}

async function checkedRun(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<void> {
  const result = await new Promise<RunnerResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (data: string) => {
      stdout += data;
    });
    child.stderr?.on("data", (data: string) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stderr, stdout });
    });
  });

  if (result.code !== 0) {
    throw new Error(formatResult(result));
  }
}

async function withGitStub(
  callback: (context: {
    argsPath: string;
    env: NodeJS.ProcessEnv;
    root: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pushgate-git-stub-"));
  const binDir = join(root, "bin");
  const argsPath = join(root, "git-args.txt");

  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(binDir, "git"),
    [
      "#!/usr/bin/env bash",
      "set -eu",
      "printf '%s\\n' \"$@\" > \"$PUSHGATE_GIT_ARGS_OUT\"",
      "exit \"${PUSHGATE_GIT_EXIT:-0}\"",
    ].join("\n"),
  );
  await chmod(join(binDir, "git"), 0o755);

  try {
    await callback({
      argsPath,
      env: {
        ...process.env,
        PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
        PUSHGATE_GIT_ARGS_OUT: argsPath,
        PUSHGATE_GIT_EXIT: "23",
      },
      root,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readArgLines(path: string): Promise<string[]> {
  return (await readFile(path, "utf8")).trimEnd().split("\n");
}

function formatResult(result: RunnerResult): string {
  return [
    `exit: ${String(result.code)}`,
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`,
  ].join("\n");
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sanitizeGitLocalEnv } from "../src/git/environment.js";
import { runPrePushWorkflow } from "../src/workflows/pre-push.js";
import type { WarningConfirmationRequest } from "../src/workflows/warning-confirmation.js";

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
    assert.match(result.stdout, /\[skip\] No checks configured/);
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
    assert.match(result.stdout, /Running 2 checks/);
    assert.match(result.stdout, /\[warn\] Diff size/);
    assert.match(result.stdout, /3 changed line\(s\) exceed max_changed_lines 2/);
    assert.match(result.stdout, /\[block\] Forbidden paths/);
    assert.match(result.stdout, /secrets\/token\.txt \(secrets\/\*\*\)/);
    assert.match(result.stdout, /1 blocking failure and 1 warning/);
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
    assert.match(result.stdout, /Running 1 check/);
    assert.match(result.stdout, /\[block\] Secrets scan/);
    assert.match(result.stdout, /src\/secret\.txt:1 \(generic-api-key\)/);
    assert.doesNotMatch(result.stdout, /Running local AI review/);
    assert.equal(result.stderr, "");
  });
});

test("deterministic warnings prompt before local AI runs", async () => {
  await withWarningToolRepo(async (repoRoot) => {
    const prompts: WarningConfirmationRequest[] = [];

    const result = await runWorkflowInRepo(repoRoot, {
      warningConfirmer: async (request) => {
        prompts.push(request);
        return true;
      },
    });

    assert.equal(result.code, 0, formatResult(result));
    assert.match(result.stdout, /\[warn\] Warn tool\s+exited with code 7/);
    assert.match(
      result.stdout,
      /Continuing with 1 warning\(s\) from deterministic checks after confirmation/,
    );
    assert.deepEqual(prompts, [
      { phase: "deterministic checks", warningCount: 1 },
    ]);
    assert.equal(result.stderr, "");
  });
});

test("declining deterministic warnings blocks the pre-push runner", async () => {
  await withWarningToolRepo(async (repoRoot) => {
    const prompts: WarningConfirmationRequest[] = [];

    const result = await runWorkflowInRepo(repoRoot, {
      warningConfirmer: async (request) => {
        prompts.push(request);
        return false;
      },
    });

    assert.equal(result.code, 1, formatResult(result));
    assert.match(result.stdout, /\[warn\] Warn tool\s+exited with code 7/);
    assert.match(
      result.stdout,
      /Push blocked because deterministic checks produced 1 warning\(s\) and continuation was not confirmed/,
    );
    assert.deepEqual(prompts, [
      { phase: "deterministic checks", warningCount: 1 },
    ]);
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
    assert.match(result.stdout, /\[skip\] No checks configured/);
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
    assert.match(result.stdout, /Provider: Claude/);
    assert.match(result.stdout, /\[block\] AI logic errors\s+src\/changed\.ts:2-3/);
    assert.match(result.stdout, /Local AI review blocked the push/);
    assert.equal(result.stderr, "");
  });
});

test("Copilot local AI warnings continue after confirmation", async () => {
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
    const prompts: WarningConfirmationRequest[] = [];

    const result = await runWorkflowInRepo(repoRoot, {
      env,
      warningConfirmer: async (request) => {
        prompts.push(request);
        return true;
      },
    });

    assert.equal(result.code, 0, formatResult(result));
    assert.match(result.stdout, /Provider: Copilot/);
    assert.match(result.stdout, /\[warn\] AI performance\s+src\/changed\.ts:2/);
    assert.match(
      result.stdout,
      /Finished with 0 blocking findings and 1 warning/,
    );
    assert.match(
      result.stdout,
      /Continuing with 1 warning\(s\) from local AI review after confirmation/,
    );
    assert.deepEqual(prompts, [
      { phase: "local AI review", warningCount: 1 },
    ]);
    assert.equal(result.stderr, "");
  });
});

test("declining local AI warnings blocks the pre-push runner", async () => {
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
    const prompts: WarningConfirmationRequest[] = [];

    const result = await runWorkflowInRepo(repoRoot, {
      env,
      warningConfirmer: async (request) => {
        prompts.push(request);
        return false;
      },
    });

    assert.equal(result.code, 1, formatResult(result));
    assert.match(result.stdout, /\[warn\] AI performance\s+src\/changed\.ts:2/);
    assert.match(
      result.stdout,
      /Push blocked because local AI review produced 1 warning\(s\) and continuation was not confirmed/,
    );
    assert.deepEqual(prompts, [
      { phase: "local AI review", warningCount: 1 },
    ]);
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
      /\[block\] Claude provider\s+Claude Code CLI was not found on PATH/,
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
      /\[block\] Claude provider\s+Claude Code CLI was not found on PATH/,
    );
    assert.equal(result.stderr, "");
  });
});

test("advisory local AI provider failures continue after confirmation", async () => {
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
    const prompts: WarningConfirmationRequest[] = [];

    const result = await runWorkflowInRepo(repoRoot, {
      warningConfirmer: async (request) => {
        prompts.push(request);
        return true;
      },
    });

    assert.equal(result.code, 0, formatResult(result));
    assert.match(
      result.stdout,
      /\[warn\] Claude provider\s+Claude Code CLI was not found on PATH/,
    );
    assert.match(result.stdout, /Continuing because ai.mode is advisory/);
    assert.match(
      result.stdout,
      /Continuing with 1 warning\(s\) from local AI review after confirmation/,
    );
    assert.deepEqual(prompts, [
      { phase: "local AI review", warningCount: 1 },
    ]);
    assert.equal(result.stderr, "");
  });
});

test("AI changed-line guardrail blocks provider invocation visibly", async () => {
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

    assert.equal(result.code, 1, formatResult(result));
    assert.match(
      result.stdout,
      /\[block\] Changed lines\s+\d+ changed lines exceed ai\.max_changed_lines 1/,
    );
    assert.match(result.stdout, /Local AI review blocked the push/);
    assert.doesNotMatch(result.stdout, /Running local AI review with claude/);
    assert.equal(result.stderr, "");
  });
});

test("push wrapper maps skip-all-checks to local preflight before native push", async () => {
  await withGitRepo(async (root) => {
    await withPreflightGitPushStub(root, async ({ argsPath, env }) => {
      const result = await runRunner(
        ["push", "--skip-all-checks", "origin", "feature"],
        undefined,
        { cwd: root, env },
      );

      assert.equal(result.code, 0, formatResult(result));
      assert.match(
        result.stdout,
        /Skipping all local Pushgate checks because pushgate\.skip-all-checks=true/,
      );
      assert.match(result.stdout, /native git push output/);
      assert.deepEqual(await readArgLines(argsPath), [
        "push",
        "--no-verify",
        "origin",
        "feature",
      ]);
    });
  });
});

test("push wrapper maps skip-ai-check to local preflight before native push", async () => {
  await withGitRepo(async (root) => {
    await writeRepoFile(
      root,
      ".pushgate.yml",
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
    await withPreflightGitPushStub(root, async ({ argsPath, env }) => {
      const result = await runRunner(
        ["push", "--skip-ai-check", "origin", "feature"],
        undefined,
        { cwd: root, env },
      );

      assert.equal(result.code, 0, formatResult(result));
      assert.match(
        result.stdout,
        /Skipping local AI because pushgate\.skip-ai-check=true/,
      );
      assert.doesNotMatch(result.stdout, /Claude Code CLI was not found on PATH/);
      assert.match(result.stdout, /native git push output/);
      assert.deepEqual(await readArgLines(argsPath), [
        "push",
        "--no-verify",
        "origin",
        "feature",
      ]);
    });
  });
});

test("push wrapper keeps skip-all precedence when both wrapper flags are present", async () => {
  await withGitRepo(async (root) => {
    await writeRepoFile(root, ".pushgate.yml", "version: nope\n");
    await withPreflightGitPushStub(root, async ({ argsPath, env }) => {
      const result = await runRunner(
        ["push", "--skip-ai-check", "--skip-all-checks", "origin", "feature"],
        undefined,
        { cwd: root, env },
      );

      assert.equal(result.code, 0, formatResult(result));
      assert.match(
        result.stdout,
        /Skipping all local Pushgate checks because pushgate\.skip-all-checks=true/,
      );
      assert.deepEqual(await readArgLines(argsPath), [
        "push",
        "--no-verify",
        "origin",
        "feature",
      ]);
    });
  });
});

test("push wrapper forwards Git args after -- without interpreting them as Pushgate flags", async () => {
  await withGitRepo(async (root) => {
    await writeRepoFile(
      root,
      ".pushgate.yml",
      "version: 2\nai:\n  mode: off\ntools: []\n",
    );
    await withPreflightGitPushStub(root, async ({ argsPath, env }) => {
      const result = await runRunner(
        ["push", "--", "--skip-ai-check", "origin", "feature"],
        undefined,
        { cwd: root, env },
      );

      assert.equal(result.code, 0, formatResult(result));
      assert.deepEqual(await readArgLines(argsPath), [
        "push",
        "--no-verify",
        "--",
        "--skip-ai-check",
        "origin",
        "feature",
      ]);
    });
  });
});

test("push wrapper runs local preflight before native push and bypasses the hook", async () => {
  await withGitRepo(async (root) => {
    await writeRepoFile(
      root,
      ".pushgate.yml",
      "version: 2\nai:\n  mode: off\ntools: []\n",
    );
    await withPreflightGitPushStub(root, async ({ argsPath, env }) => {
      const result = await runRunner(["push", "origin", "feature"], undefined, {
        cwd: root,
        env,
      });

      assert.equal(result.code, 0, formatResult(result));
      assert.match(result.stdout, /Pushgate v\d+\.\d+\.\d+ - pre-push/);
      assert.match(result.stdout, /Pushgate passed/);
      assert.match(result.stdout, /native git push output/);
      assert.deepEqual(await readArgLines(argsPath), [
        "push",
        "--no-verify",
        "origin",
        "feature",
      ]);
    });
  });
});

test("push wrapper normalizes verify flags before bypassing the native hook", async () => {
  await withGitRepo(async (root) => {
    await writeRepoFile(
      root,
      ".pushgate.yml",
      "version: 2\nai:\n  mode: off\ntools: []\n",
    );
    await withPreflightGitPushStub(root, async ({ argsPath, env }) => {
      const result = await runRunner(
        ["push", "--no-verify", "--verify", "origin", "feature"],
        undefined,
        { cwd: root, env },
      );

      assert.equal(result.code, 0, formatResult(result));
      assert.deepEqual(await readArgLines(argsPath), [
        "push",
        "--no-verify",
        "origin",
        "feature",
      ]);
    });
  });
});

test("push wrapper does not open native push when local preflight fails", async () => {
  await withGitRepo(async (root) => {
    await writeRepoFile(root, ".pushgate.yml", "version: nope\n");
    await withPreflightGitPushStub(root, async ({ argsPath, env }) => {
      const result = await runRunner(["push", "origin", "feature"], undefined, {
        cwd: root,
        env,
      });

      assert.equal(result.code, 1, formatResult(result));
      assert.match(result.stderr, /Invalid Pushgate v2 config/);
      await assert.rejects(readFile(argsPath, "utf8"));
    });
  });
});

test("push wrapper prints upstream and GitHub SSH PR URL after successful --set-upstream push", async () => {
  await withGitPushSummaryStub(
    {
      currentBranch: "codex/cli-ux",
      remoteUrl: "git@github.com:rootstrap/ai-pushgate.git",
      upstream: "origin/codex/cli-ux",
    },
    async ({ env, logPath, root }) => {
      const result = await runRunner(
        ["push", "--set-upstream", "origin", "codex/cli-ux"],
        undefined,
        { cwd: root, env },
      );

      assert.equal(result.code, 0, formatResult(result));
      assert.match(result.stdout, /native git push output/);
      assert.match(result.stdout, /Pushing branch/);
      assert.match(result.stdout, /  \[ok\] Branch pushed/);
      assert.match(
        result.stdout,
        /  \[ok\] Upstream set\s+origin\/codex\/cli-ux/,
      );
      assert.match(
        result.stdout,
        /https:\/\/github\.com\/rootstrap\/ai-pushgate\/pull\/new\/codex%2Fcli-ux/,
      );
      assert.match(
        await readFile(logPath, "utf8"),
        /call\tremote\tget-url\torigin/,
      );
      assert.equal(result.stderr, "");
    },
  );
});

test("push wrapper prints upstream and GitHub HTTPS PR URL after successful -u push", async () => {
  await withGitPushSummaryStub(
    {
      currentBranch: "feature/http",
      remoteUrl: "https://github.com/rootstrap/ai-pushgate",
      upstream: "origin/feature/http",
    },
    async ({ env, root }) => {
      const result = await runRunner(
        ["push", "-u", "origin", "feature/http"],
        undefined,
        { cwd: root, env },
      );

      assert.equal(result.code, 0, formatResult(result));
      assert.match(result.stdout, /Pushing branch/);
      assert.match(result.stdout, /  \[ok\] Branch pushed/);
      assert.match(
        result.stdout,
        /  \[ok\] Upstream set\s+origin\/feature\/http/,
      );
      assert.match(
        result.stdout,
        /https:\/\/github\.com\/rootstrap\/ai-pushgate\/pull\/new\/feature%2Fhttp/,
      );
      assert.equal(result.stderr, "");
    },
  );
});

test("push wrapper omits PR URL for non-GitHub remotes", async () => {
  await withGitPushSummaryStub(
    {
      currentBranch: "feature",
      remoteUrl: "https://gitlab.example.test/rootstrap/ai-pushgate.git",
      upstream: "origin/feature",
    },
    async ({ env, root }) => {
      const result = await runRunner(
        ["push", "-u", "origin", "feature"],
        undefined,
        { cwd: root, env },
      );

      assert.equal(result.code, 0, formatResult(result));
      assert.match(result.stdout, /Pushing branch/);
      assert.match(result.stdout, /  \[ok\] Branch pushed/);
      assert.match(result.stdout, /  \[ok\] Upstream set\s+origin\/feature/);
      assert.doesNotMatch(result.stdout, /Create a pull request:/);
      assert.doesNotMatch(result.stdout, /pull\/new/);
      assert.equal(result.stderr, "");
    },
  );
});

test("push wrapper preserves failed Git push exit code without success rows", async () => {
  await withGitPushSummaryStub(
    {
      currentBranch: "feature",
      pushExit: "23",
      remoteUrl: "git@github.com:rootstrap/ai-pushgate.git",
      upstream: "origin/feature",
    },
    async ({ env, root }) => {
      const result = await runRunner(
        ["push", "-u", "origin", "feature"],
        undefined,
        { cwd: root, env },
      );

      assert.equal(result.code, 23, formatResult(result));
      assert.match(result.stdout, /native git push output/);
      assert.doesNotMatch(result.stdout, /Pushing branch/);
      assert.doesNotMatch(result.stdout, /Create a pull request:/);
      assert.equal(result.stderr, "");
    },
  );
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
      env: { ...sanitizeGitLocalEnv(process.env), ...options.env },
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

async function runWorkflowInRepo(
  repoRoot: string,
  options: {
    env?: NodeJS.ProcessEnv;
    warningConfirmer?: (
      request: WarningConfirmationRequest,
    ) => Promise<boolean>;
  } = {},
): Promise<RunnerResult> {
  const previousCwd = process.cwd();
  const stdout = captureOutput();
  const stderr = captureOutput();

  process.chdir(repoRoot);

  try {
    const code = await runPrePushWorkflow({
      env: { ...sanitizeGitLocalEnv(process.env), ...options.env },
      stderr: stderr.stream,
      stdin: Readable.from(""),
      stdout: stdout.stream,
      ...(options.warningConfirmer
        ? { warningConfirmer: options.warningConfirmer }
        : {}),
    });

    return {
      code,
      stderr: stderr.text(),
      stdout: stdout.text(),
    };
  } finally {
    process.chdir(previousCwd);
  }
}

function captureOutput(): {
  stream: Writable;
  text(): string;
} {
  let output = "";

  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    }),
    text() {
      return output;
    },
  };
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

async function withWarningToolRepo(
  callback: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const repoRoot = await mkdtemp(join(tmpdir(), "pushgate-warning-cli-"));

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
        "tools:",
        "  - name: warn-tool",
        `    command: ${JSON.stringify([process.execPath, "-e", "process.exit(7);"])}`,
        "    mode: warning",
        "    run: always",
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
    await writeRepoFile(repoRoot, "README.md", "base\nfeature\n");
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
      ...sanitizeGitLocalEnv(process.env),
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
      ...sanitizeGitLocalEnv(process.env),
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
      env: sanitizeGitLocalEnv(process.env),
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
        ...sanitizeGitLocalEnv(process.env),
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

async function withPreflightGitPushStub(
  root: string,
  callback: (context: {
    argsPath: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<void>,
): Promise<void> {
  const binDir = join(root, "preflight-bin");
  const argsPath = join(root, "git-push-args.txt");

  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(binDir, "git"),
    [
      "#!/usr/bin/env bash",
      "set -eu",
      "if [ \"${1:-}\" = 'push' ]; then",
      "  printf '%s\\n' \"$@\" > \"$PUSHGATE_GIT_PUSH_ARGS_OUT\"",
      "  printf 'native git push output\\n'",
      "  exit \"${PUSHGATE_GIT_PUSH_EXIT:-0}\"",
      "fi",
      "exec \"$PUSHGATE_REAL_GIT\" \"$@\"",
    ].join("\n"),
  );
  await chmod(join(binDir, "git"), 0o755);

  await callback({
    argsPath,
    env: {
      ...sanitizeGitLocalEnv(process.env),
      PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
      PUSHGATE_GIT_PUSH_ARGS_OUT: argsPath,
      PUSHGATE_GIT_PUSH_EXIT: "0",
      PUSHGATE_REAL_GIT: "/usr/bin/git",
    },
  });
}

async function withGitPushSummaryStub(
  options: {
    currentBranch: string;
    pushExit?: string;
    remoteUrl: string;
    upstream?: string;
  },
  callback: (context: {
    env: NodeJS.ProcessEnv;
    logPath: string;
    root: string;
  }) => Promise<void>,
): Promise<void> {
  await withGitRepo(async (root) => {
    const binDir = join(root, "bin");
    const logPath = join(root, "git-calls.txt");

    await writeRepoFile(
      root,
      ".pushgate.yml",
      "version: 2\nai:\n  mode: off\ntools: []\n",
    );
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "git"),
      [
        "#!/usr/bin/env bash",
        "set -eu",
        "{ printf 'call'; for arg in \"$@\"; do printf '\\t%s' \"$arg\"; done; printf '\\n'; } >> \"$PUSHGATE_GIT_CALLS_OUT\"",
        "if [ \"${1:-}\" = 'push' ] || { [ \"${1:-}\" = '-c' ] && [ \"${3:-}\" = 'push' ]; }; then",
        "  printf 'native git push output\\n'",
        "  exit \"${PUSHGATE_GIT_PUSH_EXIT:-0}\"",
        "fi",
        "if [ \"${1:-}\" = 'rev-parse' ] && [ \"${2:-}\" = '--abbrev-ref' ] && [ \"${3:-}\" = '--symbolic-full-name' ]; then",
        "  if [ -n \"${PUSHGATE_GIT_UPSTREAM:-}\" ]; then",
        "    printf '%s\\n' \"$PUSHGATE_GIT_UPSTREAM\"",
        "    exit 0",
        "  fi",
        "  exit 1",
        "fi",
        "if [ \"${1:-}\" = 'rev-parse' ] && [ \"${2:-}\" = '--abbrev-ref' ] && [ \"${3:-}\" = 'HEAD' ]; then",
        "  printf '%s\\n' \"$PUSHGATE_GIT_CURRENT_BRANCH\"",
        "  exit 0",
        "fi",
        "if [ \"${1:-}\" = 'remote' ] && [ \"${2:-}\" = 'get-url' ]; then",
        "  printf '%s\\n' \"$PUSHGATE_GIT_REMOTE_URL\"",
        "  exit 0",
        "fi",
        "if [ \"${1:-}\" = 'config' ] && [ \"${2:-}\" = '--get' ]; then",
        "  printf 'origin\\n'",
        "  exit 0",
        "fi",
        "exec \"$PUSHGATE_REAL_GIT\" \"$@\"",
      ].join("\n"),
    );
    await chmod(join(binDir, "git"), 0o755);

    await callback({
      env: {
        ...sanitizeGitLocalEnv(process.env),
        PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
        PUSHGATE_GIT_CALLS_OUT: logPath,
        PUSHGATE_GIT_CURRENT_BRANCH: options.currentBranch,
        PUSHGATE_GIT_PUSH_EXIT: options.pushExit ?? "0",
        PUSHGATE_GIT_REMOTE_URL: options.remoteUrl,
        PUSHGATE_REAL_GIT: "/usr/bin/git",
        PUSHGATE_GIT_UPSTREAM: options.upstream ?? "",
      },
      logPath,
      root,
    });
  });
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

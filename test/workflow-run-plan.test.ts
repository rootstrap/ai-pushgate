import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import { sanitizeGitLocalEnv } from "../src/git/environment.js";
import { runPrePushWorkflow } from "../src/workflows/pre-push.js";

test("skip-all-checks bypasses config loading", async () => {
  await withGitRepo(async (repoRoot) => {
    await writeRepoFile(repoRoot, ".pushgate.yml", "version: nope\n");
    await checkedRun("git", ["config", "pushgate.skip-all-checks", "true"], {
      cwd: repoRoot,
    });

    const result = await runWorkflowInRepo(repoRoot);

    assert.equal(result.code, 0, formatResult(result));
    assert.match(
      result.stdout,
      /Skipping all local Pushgate checks because pushgate\.skip-all-checks=true/,
    );
    assert.equal(result.stderr, "");
  });
});

test("skip-ai-check still loads config", async () => {
  await withGitRepo(async (repoRoot) => {
    await writeRepoFile(repoRoot, ".pushgate.yml", "version: nope\n");
    await checkedRun("git", ["config", "pushgate.skip-ai-check", "true"], {
      cwd: repoRoot,
    });

    await assert.rejects(
      () => runWorkflowInRepo(repoRoot),
      /Invalid Pushgate v2 config/,
    );
  });
});

test("inactive deterministic checks and local AI do not resolve changed files", async () => {
  await withGitRepo(async (repoRoot) => {
    await writeRepoFile(
      repoRoot,
      ".pushgate.yml",
      [
        "version: 2",
        "review:",
        "  target_branch: branch-that-does-not-exist",
        "ai:",
        "  mode: off",
        "tools: []",
        "",
      ].join("\n"),
    );

    const result = await runWorkflowInRepo(repoRoot);

    assert.equal(result.code, 0, formatResult(result));
    assert.match(result.stdout, /\[skip\] No checks configured/);
    assert.match(result.stdout, /Pushgate passed\. Changes allowed\.\.\./);
    assert.equal(result.stderr, "");
  });
});

test("skip-ai-check keeps deterministic changed-file work", async () => {
  await withChangedFileRepo(async (repoRoot) => {
    await writeRepoFile(
      repoRoot,
      ".pushgate.yml",
      [
        "version: 2",
        "ai:",
        "  mode: blocking",
        "  provider: claude",
        "  providers:",
        "    claude: {}",
        "tools:",
        "  - name: changed-files-tool",
        `    command: ${JSON.stringify([process.execPath, "-e", "process.exit(0);"])}`,
        "    run: changed_files",
        "",
      ].join("\n"),
    );
    await checkedRun("git", ["config", "pushgate.skip-ai-check", "true"], {
      cwd: repoRoot,
    });

    const result = await runWorkflowInRepo(repoRoot);

    assert.equal(result.code, 0, formatResult(result));
    assert.match(result.stdout, /Running 1 check/);
    assert.match(result.stdout, /\[ok\] Changed files tool/);
    assert.match(
      result.stdout,
      /Skipping local AI because pushgate\.skip-ai-check=true/,
    );
    assert.doesNotMatch(result.stdout, /Claude Code CLI was not found on PATH/);
    assert.equal(result.stderr, "");
  });
});

interface WorkflowResult {
  code: number;
  stderr: string;
  stdout: string;
}

async function runWorkflowInRepo(repoRoot: string): Promise<WorkflowResult> {
  const previousCwd = process.cwd();
  const stdout = captureOutput();
  const stderr = captureOutput();

  process.chdir(repoRoot);

  try {
    const code = await runPrePushWorkflow({
      env: sanitizeGitLocalEnv(process.env),
      stderr: stderr.stream,
      stdin: Readable.from(""),
      stdout: stdout.stream,
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

async function withGitRepo(
  callback: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const repoRoot = await mkdtemp(join(tmpdir(), "pushgate-workflow-"));

  try {
    await checkedRun("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: repoRoot,
    });
    await callback(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

async function withChangedFileRepo(
  callback: (repoRoot: string) => Promise<void>,
): Promise<void> {
  await withGitRepo(async (repoRoot) => {
    await checkedRun("git", ["config", "user.email", "workflow@example.test"], {
      cwd: repoRoot,
    });
    await checkedRun("git", ["config", "user.name", "Pushgate Workflow"], {
      cwd: repoRoot,
    });
    await writeRepoFile(repoRoot, "src/changed.ts", "export const value = 1;\n");
    await checkedRun("git", ["add", "--all"], { cwd: repoRoot });
    await checkedRun("git", ["commit", "--quiet", "-m", "baseline"], {
      cwd: repoRoot,
    });
    await checkedRun("git", ["switch", "--quiet", "-c", "feature"], {
      cwd: repoRoot,
    });
    await writeRepoFile(repoRoot, "src/changed.ts", "export const value = 2;\n");
    await checkedRun("git", ["add", "--all"], { cwd: repoRoot });
    await checkedRun("git", ["commit", "--quiet", "-m", "feature"], {
      cwd: repoRoot,
    });

    await callback(repoRoot);
  });
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

interface CommandOptions {
  cwd: string;
}

async function checkedRun(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<void> {
  const result = await new Promise<{
    code: number | null;
    stderr: string;
    stdout: string;
  }>((resolve, reject) => {
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

function formatResult(result: {
  code: number | null;
  stderr: string;
  stdout: string;
}): string {
  return [
    `exit: ${String(result.code)}`,
    "stdout:",
    result.stdout,
    "stderr:",
    result.stderr,
  ].join("\n");
}

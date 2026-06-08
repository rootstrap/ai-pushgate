import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  const repoRoot = await mkdtemp(join(tmpdir(), "pushgate-cli-"));

  try {
    await checkedRun("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: repoRoot,
    });
    await writeFile(
      join(repoRoot, ".pushgate.yml"),
      "version: 2\nai:\n  mode: off\ntools: []\n",
    );
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

function formatResult(result: RunnerResult): string {
  return [
    `exit: ${String(result.code)}`,
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`,
  ].join("\n");
}

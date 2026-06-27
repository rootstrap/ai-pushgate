import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runGit } from "../src/git/command.js";
import {
  isGitLocalEnvVar,
  sanitizeGitLocalEnv,
} from "../src/git/environment.js";

test("sanitizeGitLocalEnv removes only Git local repository binding vars", () => {
  const sanitized = sanitizeGitLocalEnv({
    CUSTOM_VALUE: "kept",
    GIT_ASKPASS: "askpass",
    GIT_COMMON_DIR: "/tmp/victim/.git",
    GIT_CONFIG: "/tmp/gitconfig",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.bare",
    GIT_CONFIG_KEY_12: "core.worktree",
    GIT_CONFIG_KEY_suffix: "kept",
    GIT_CONFIG_PARAMETERS: "'core.bare'='true'",
    GIT_CONFIG_VALUE_0: "true",
    GIT_CONFIG_VALUE_12: "/tmp/victim",
    GIT_CONFIG_VALUE_suffix: "kept",
    GIT_DIR: "/tmp/victim/.git",
    GIT_INDEX_FILE: "/tmp/victim/.git/index",
    GIT_SSH_COMMAND: "ssh -i key",
    GIT_TERMINAL_PROMPT: "0",
    GIT_WORK_TREE: "/tmp/victim",
    PATH: "/usr/bin",
  });

  assert.deepEqual(sanitized, {
    CUSTOM_VALUE: "kept",
    GIT_ASKPASS: "askpass",
    GIT_CONFIG_KEY_suffix: "kept",
    GIT_CONFIG_VALUE_suffix: "kept",
    GIT_SSH_COMMAND: "ssh -i key",
    GIT_TERMINAL_PROMPT: "0",
    PATH: "/usr/bin",
  });
});

test("sanitizeGitLocalEnv can preserve Git config overlays for skip-control reads", () => {
  const sanitized = sanitizeGitLocalEnv(
    {
      GIT_CONFIG: "/tmp/gitconfig",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "pushgate.skip-ai-check",
      GIT_CONFIG_PARAMETERS: "'pushgate.skip-ai-check'='true'",
      GIT_CONFIG_VALUE_0: "true",
      GIT_DIR: "/tmp/victim/.git",
      GIT_WORK_TREE: "/tmp/victim",
    },
    {
      preserveGitConfigOverlay: true,
    },
  );

  assert.deepEqual(sanitized, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "pushgate.skip-ai-check",
    GIT_CONFIG_PARAMETERS: "'pushgate.skip-ai-check'='true'",
    GIT_CONFIG_VALUE_0: "true",
  });
});

test("isGitLocalEnvVar recognizes static and indexed Git config vars", () => {
  assert.equal(isGitLocalEnvVar("GIT_DIR"), true);
  assert.equal(isGitLocalEnvVar("GIT_CONFIG_VALUE_0"), true);
  assert.equal(isGitLocalEnvVar("GIT_CONFIG_KEY_42"), true);
  assert.equal(isGitLocalEnvVar("GIT_SSH_COMMAND"), false);
  assert.equal(isGitLocalEnvVar("GIT_CONFIG_KEY_suffix"), false);
});

test("runGit ignores inherited hook-local Git env for explicit repo roots", async () => {
  await withTempDir("pushgate-git-env-", async (tempRoot) => {
    const victimRoot = join(tempRoot, "victim");
    const targetRoot = join(tempRoot, "target");

    await initRepo(victimRoot);
    await initRepo(targetRoot);

    const result = await runGit(targetRoot, ["rev-parse", "--show-toplevel"], {
      env: {
        ...sanitizeGitLocalEnv(process.env),
        ...poisonedGitEnv(victimRoot),
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      await realpath(result.stdout.trim()),
      await realpath(targetRoot),
    );
  });
});

function poisonedGitEnv(victimRoot: string): NodeJS.ProcessEnv {
  return {
    GIT_COMMON_DIR: join(victimRoot, ".git"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.bare",
    GIT_CONFIG_VALUE_0: "true",
    GIT_DIR: join(victimRoot, ".git"),
    GIT_INDEX_FILE: join(victimRoot, ".git", "index"),
    GIT_WORK_TREE: victimRoot,
  };
}

async function initRepo(repoRoot: string): Promise<void> {
  await checkedRun("git", ["init", "--quiet", "--initial-branch=main", repoRoot]);
}

async function withTempDir(
  prefix: string,
  callback: (tempRoot: string) => Promise<void>,
): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), prefix));

  try {
    await callback(tempRoot);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

async function checkedRun(command: string, args: string[]): Promise<void> {
  const result = await new Promise<{
    code: number | null;
    stderr: string;
    stdout: string;
  }>((resolve, reject) => {
    const child = spawn(command, args, {
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
    throw new Error(
      [
        `${command} ${args.join(" ")} exited with ${String(result.code)}.`,
        `stdout:\n${result.stdout}`,
        `stderr:\n${result.stderr}`,
      ].join("\n"),
    );
  }
}

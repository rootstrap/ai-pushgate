import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import { sanitizeGitLocalEnv } from "../src/git/environment.js";
import type {
  ReviewTargetCandidate,
  ReviewTargetSelector,
} from "../src/workflows/review-target-selection.js";
import { runPrePushWorkflow } from "../src/workflows/pre-push.js";

const ZERO_OBJECT = "0".repeat(40);

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
    assert.match(result.stdout, /Local Push Gate passed\. Push allowed\./);
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
      /Local AI Review\s+skipped because pushgate\.skip-ai-check=true/,
    );
    assert.doesNotMatch(result.stdout, /Claude Code CLI was not found on PATH/);
    assert.equal(result.stderr, "");
  });
});

test("existing destination branch can review only the incremental push diff", async () => {
  await withIncrementalPushRepo(async (repoRoot, commits) => {
    await writeChangedFilesAssertionConfig(repoRoot, ["src/two.ts"]);

    const seenCandidates: ReviewTargetCandidate[] = [];
    const selector: ReviewTargetSelector = async (request) => {
      seenCandidates.push(...request.candidates);
      const incremental = request.candidates.find(
        (candidate) => candidate.source === "incremental",
      );

      assert.ok(incremental, "expected an incremental review target candidate");
      return incremental;
    };

    const result = await runWorkflowInRepo(repoRoot, {
      hookArgs: ["origin", "git@example.test:repo.git"],
      reviewTargetSelector: selector,
      stdin: Readable.from(
        `refs/heads/feature ${commits.head} refs/heads/feature ${commits.remoteFeature}\n`,
      ),
    });

    assert.equal(result.code, 0, formatResult(result));
    assert.deepEqual(
      seenCandidates.map((candidate) => candidate.source),
      ["configured", "incremental"],
    );
    assert.match(
      result.stdout,
      /Review target:\s+destination feature tip/,
    );
    assert.match(result.stdout, /Review range:/);
    assert.match(result.stdout, /Checks passed/);
    assert.equal(result.stderr, "");
  });
});

test("missing pre-push stdin falls back to the current branch remote-tracking ref", async () => {
  await withIncrementalPushRepo(async (repoRoot, commits) => {
    await writeChangedFilesAssertionConfig(repoRoot, ["src/two.ts"]);
    await checkedRun(
      "git",
      ["update-ref", "refs/remotes/origin/feature", commits.remoteFeature],
      { cwd: repoRoot },
    );

    const selector: ReviewTargetSelector = async (request) => {
      const incremental = request.candidates.find(
        (candidate) => candidate.source === "incremental",
      );

      assert.ok(incremental, "expected an incremental review target candidate");
      return incremental;
    };

    const result = await runWorkflowInRepo(repoRoot, {
      hookArgs: ["origin", "git@example.test:repo.git"],
      reviewTargetSelector: selector,
    });

    assert.equal(result.code, 0, formatResult(result));
    assert.match(
      result.stdout,
      /Review target:\s+destination feature tip/,
    );
    assert.match(result.stdout, /Checks passed/);
    assert.equal(result.stderr, "");
  });
});

test("stale local target prompts with the fetched remote target candidate", async () => {
  await withStaleTargetRepo(async (repoRoot, commits) => {
    await writeChangedFilesAssertionConfig(repoRoot, ["src/feature.ts"]);

    const seenDiagnostics: string[] = [];
    const seenCandidates: ReviewTargetCandidate[] = [];
    const selector: ReviewTargetSelector = async (request) => {
      seenDiagnostics.push(
        ...request.diagnostics.map((diagnostic) => diagnostic.message),
      );
      seenCandidates.push(...request.candidates);
      const targetRemote = request.candidates.find(
        (candidate) => candidate.source === "target-remote",
      );

      assert.ok(targetRemote, "expected a target remote candidate");
      return targetRemote;
    };

    const result = await runWorkflowInRepo(repoRoot, {
      hookArgs: ["origin", "git@example.test:repo.git"],
      reviewTargetSelector: selector,
      stdin: Readable.from(
        `refs/heads/feature ${commits.head} refs/heads/feature ${ZERO_OBJECT}\n`,
      ),
    });

    assert.equal(result.code, 0, formatResult(result));
    assert.deepEqual(
      seenCandidates.map((candidate) => candidate.source),
      ["configured", "target-remote"],
    );
    assert.match(seenDiagnostics.join("\n"), /main is behind origin\/main/);
    assert.match(result.stdout, /main is behind origin\/main/);
    assert.match(result.stdout, /Run `git fetch origin`/);
    assert.match(result.stdout, /Review target:\s+origin\/main/);
    assert.equal(result.stderr, "");
  });
});

test("stacked remote ancestor can review only the stacked branch diff", async () => {
  await withStackedFeatureRepo(async (repoRoot, commits) => {
    await writeChangedFilesAssertionConfig(repoRoot, ["src/part2.ts"]);

    const seenCandidates: ReviewTargetCandidate[] = [];
    const selector: ReviewTargetSelector = async (request) => {
      seenCandidates.push(...request.candidates);
      const stacked = request.candidates.find(
        (candidate) => candidate.source === "stacked",
      );

      assert.ok(stacked, "expected a stacked review target candidate");
      return stacked;
    };

    const result = await runWorkflowInRepo(repoRoot, {
      hookArgs: ["origin", "git@example.test:repo.git"],
      reviewTargetSelector: selector,
      stdin: Readable.from(
        `refs/heads/part-2-of-feature-A ${commits.head} refs/heads/part-2-of-feature-A ${ZERO_OBJECT}\n`,
      ),
    });

    assert.equal(result.code, 0, formatResult(result));
    assert.deepEqual(
      seenCandidates.map((candidate) => candidate.source),
      ["configured", "stacked"],
    );
    assert.match(
      result.stdout,
      /Review target:\s+origin\/part-1-of-feature-A/,
    );
    assert.match(result.stdout, /Checks passed/);
    assert.equal(result.stderr, "");
  });
});

test("one-push review target override skips interactive selection", async () => {
  await withIncrementalPushRepo(async (repoRoot, commits) => {
    await writeChangedFilesAssertionConfig(repoRoot, [
      "src/one.ts",
      "src/two.ts",
    ]);
    await checkedRun("git", ["config", "pushgate.review-target", "main"], {
      cwd: repoRoot,
    });

    const result = await runWorkflowInRepo(repoRoot, {
      hookArgs: ["origin", "git@example.test:repo.git"],
      reviewTargetSelector: async () => {
        throw new Error("override should skip review target selection");
      },
      stdin: Readable.from(
        `refs/heads/feature ${commits.head} refs/heads/feature ${commits.remoteFeature}\n`,
      ),
    });

    assert.equal(result.code, 0, formatResult(result));
    assert.match(result.stdout, /Review target:\s+main/);
    assert.match(result.stdout, /Checks passed/);
    assert.equal(result.stderr, "");
  });
});

test("one-push review target override reports an invalid ref explicitly", async () => {
  await withIncrementalPushRepo(async (repoRoot, commits) => {
    await writeChangedFilesAssertionConfig(repoRoot, ["src/two.ts"]);
    await checkedRun(
      "git",
      ["config", "pushgate.review-target", "does-not-exist"],
      { cwd: repoRoot },
    );

    const result = await runWorkflowInRepo(repoRoot, {
      hookArgs: ["origin", "git@example.test:repo.git"],
      reviewTargetSelector: async () => {
        throw new Error("override should skip review target selection");
      },
      stdin: Readable.from(
        `refs/heads/feature ${commits.head} refs/heads/feature ${commits.remoteFeature}\n`,
      ),
    });

    assert.equal(result.code, 1, formatResult(result));
    assert.match(result.stdout, /pushgate\.review-target="does-not-exist"/);
    assert.match(result.stdout, /cannot be resolved locally/);
    assert.doesNotMatch(result.stdout, /Configured review\.target_branch/);
    assert.equal(result.stderr, "");
  });
});

test("multi-branch pushes fail before choosing one review target", async () => {
  await withIncrementalPushRepo(async (repoRoot, commits) => {
    await writeChangedFilesAssertionConfig(repoRoot, ["src/two.ts"]);

    const result = await runWorkflowInRepo(repoRoot, {
      hookArgs: ["origin", "git@example.test:repo.git"],
      stdin: Readable.from(
        [
          `refs/heads/feature ${commits.head} refs/heads/feature ${commits.remoteFeature}`,
          `refs/heads/other ${commits.head} refs/heads/other ${ZERO_OBJECT}`,
          "",
        ].join("\n"),
      ),
    });

    assert.equal(result.code, 1, formatResult(result));
    assert.match(result.stdout, /updates multiple branches/);
    assert.match(result.stdout, /Push one branch at a time/);
    assert.equal(result.stderr, "");
  });
});

test("multi-branch pushes fail even when review target override is set", async () => {
  await withIncrementalPushRepo(async (repoRoot, commits) => {
    await writeChangedFilesAssertionConfig(repoRoot, ["src/two.ts"]);
    await checkedRun("git", ["config", "pushgate.review-target", "main"], {
      cwd: repoRoot,
    });

    const result = await runWorkflowInRepo(repoRoot, {
      hookArgs: ["origin", "git@example.test:repo.git"],
      stdin: Readable.from(
        [
          `refs/heads/feature ${commits.head} refs/heads/feature ${commits.remoteFeature}`,
          `refs/heads/other ${commits.head} refs/heads/other ${ZERO_OBJECT}`,
          "",
        ].join("\n"),
      ),
    });

    assert.equal(result.code, 1, formatResult(result));
    assert.match(result.stdout, /updates multiple branches/);
    assert.match(result.stdout, /Push one branch at a time/);
    assert.doesNotMatch(result.stdout, /Review target:\s+main/);
    assert.equal(result.stderr, "");
  });
});

interface WorkflowResult {
  code: number;
  stderr: string;
  stdout: string;
}

interface RunWorkflowOptions {
  hookArgs?: readonly string[];
  reviewTargetSelector?: ReviewTargetSelector;
  stdin?: Readable;
}

async function runWorkflowInRepo(
  repoRoot: string,
  options: RunWorkflowOptions = {},
): Promise<WorkflowResult> {
  const previousCwd = process.cwd();
  const stdout = captureOutput();
  const stderr = captureOutput();

  process.chdir(repoRoot);

  try {
    const code = await runPrePushWorkflow({
      env: sanitizeGitLocalEnv(process.env),
      hookArgs: options.hookArgs,
      reviewTargetSelector: options.reviewTargetSelector,
      stderr: stderr.stream,
      stdin: options.stdin ?? Readable.from(""),
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

async function withIncrementalPushRepo(
  callback: (
    repoRoot: string,
    commits: { head: string; remoteFeature: string },
  ) => Promise<void>,
): Promise<void> {
  await withGitRepo(async (repoRoot) => {
    await checkedRun("git", ["config", "user.email", "workflow@example.test"], {
      cwd: repoRoot,
    });
    await checkedRun("git", ["config", "user.name", "Pushgate Workflow"], {
      cwd: repoRoot,
    });
    await writeRepoFile(repoRoot, "README.md", "baseline\n");
    await checkedRun("git", ["add", "--all"], { cwd: repoRoot });
    await checkedRun("git", ["commit", "--quiet", "-m", "baseline"], {
      cwd: repoRoot,
    });
    await checkedRun("git", ["switch", "--quiet", "-c", "feature"], {
      cwd: repoRoot,
    });
    await writeRepoFile(repoRoot, "src/one.ts", "export const one = 1;\n");
    await checkedRun("git", ["add", "--all"], { cwd: repoRoot });
    await checkedRun("git", ["commit", "--quiet", "-m", "feature one"], {
      cwd: repoRoot,
    });
    const remoteFeature = await gitStdout(repoRoot, ["rev-parse", "HEAD"]);

    await writeRepoFile(repoRoot, "src/two.ts", "export const two = 2;\n");
    await checkedRun("git", ["add", "--all"], { cwd: repoRoot });
    await checkedRun("git", ["commit", "--quiet", "-m", "feature two"], {
      cwd: repoRoot,
    });
    const head = await gitStdout(repoRoot, ["rev-parse", "HEAD"]);

    await callback(repoRoot, { head, remoteFeature });
  });
}

async function withStaleTargetRepo(
  callback: (
    repoRoot: string,
    commits: { head: string; originMain: string },
  ) => Promise<void>,
): Promise<void> {
  await withGitRepo(async (repoRoot) => {
    await checkedRun("git", ["config", "user.email", "workflow@example.test"], {
      cwd: repoRoot,
    });
    await checkedRun("git", ["config", "user.name", "Pushgate Workflow"], {
      cwd: repoRoot,
    });
    await writeRepoFile(repoRoot, "README.md", "baseline\n");
    await checkedRun("git", ["add", "--all"], { cwd: repoRoot });
    await checkedRun("git", ["commit", "--quiet", "-m", "baseline"], {
      cwd: repoRoot,
    });

    await checkedRun("git", ["switch", "--quiet", "-c", "remote-main"], {
      cwd: repoRoot,
    });
    await writeRepoFile(repoRoot, "src/remote.ts", "export const remote = 1;\n");
    await checkedRun("git", ["add", "--all"], { cwd: repoRoot });
    await checkedRun("git", ["commit", "--quiet", "-m", "remote main"], {
      cwd: repoRoot,
    });
    const originMain = await gitStdout(repoRoot, ["rev-parse", "HEAD"]);
    await checkedRun(
      "git",
      ["update-ref", "refs/remotes/origin/main", originMain],
      { cwd: repoRoot },
    );

    await checkedRun("git", ["switch", "--quiet", "main"], { cwd: repoRoot });
    await checkedRun("git", ["switch", "--quiet", "-c", "feature"], {
      cwd: repoRoot,
    });
    await writeRepoFile(
      repoRoot,
      "src/feature.ts",
      "export const feature = 1;\n",
    );
    await checkedRun("git", ["add", "--all"], { cwd: repoRoot });
    await checkedRun("git", ["commit", "--quiet", "-m", "feature"], {
      cwd: repoRoot,
    });
    const head = await gitStdout(repoRoot, ["rev-parse", "HEAD"]);

    await callback(repoRoot, { head, originMain });
  });
}

async function withStackedFeatureRepo(
  callback: (
    repoRoot: string,
    commits: { head: string; part1: string },
  ) => Promise<void>,
): Promise<void> {
  await withGitRepo(async (repoRoot) => {
    await checkedRun("git", ["config", "user.email", "workflow@example.test"], {
      cwd: repoRoot,
    });
    await checkedRun("git", ["config", "user.name", "Pushgate Workflow"], {
      cwd: repoRoot,
    });
    await writeRepoFile(repoRoot, "README.md", "baseline\n");
    await checkedRun("git", ["add", "--all"], { cwd: repoRoot });
    await checkedRun("git", ["commit", "--quiet", "-m", "baseline"], {
      cwd: repoRoot,
    });

    await checkedRun(
      "git",
      ["switch", "--quiet", "-c", "part-1-of-feature-A"],
      { cwd: repoRoot },
    );
    await writeRepoFile(repoRoot, "src/part1.ts", "export const part1 = 1;\n");
    await checkedRun("git", ["add", "--all"], { cwd: repoRoot });
    await checkedRun("git", ["commit", "--quiet", "-m", "part one"], {
      cwd: repoRoot,
    });
    const part1 = await gitStdout(repoRoot, ["rev-parse", "HEAD"]);
    await checkedRun(
      "git",
      ["update-ref", "refs/remotes/origin/part-1-of-feature-A", part1],
      { cwd: repoRoot },
    );

    await checkedRun(
      "git",
      ["switch", "--quiet", "-c", "part-2-of-feature-A"],
      { cwd: repoRoot },
    );
    await writeRepoFile(repoRoot, "src/part2.ts", "export const part2 = 2;\n");
    await checkedRun("git", ["add", "--all"], { cwd: repoRoot });
    await checkedRun("git", ["commit", "--quiet", "-m", "part two"], {
      cwd: repoRoot,
    });
    const head = await gitStdout(repoRoot, ["rev-parse", "HEAD"]);

    await callback(repoRoot, { head, part1 });
  });
}

async function writeChangedFilesAssertionConfig(
  repoRoot: string,
  expectedPaths: readonly string[],
): Promise<void> {
  const assertion = [
    "const assert = require('node:assert/strict');",
    `const expected = ${JSON.stringify([...expectedPaths].sort())};`,
    "const actual = process.argv.slice(1).sort();",
    "assert.deepEqual(actual, expected);",
  ].join(" ");

  await writeRepoFile(
    repoRoot,
    ".pushgate.yml",
    [
      "version: 2",
      "review:",
      "  target_branch: main",
      "ai:",
      "  mode: off",
      "tools:",
      "  - name: changed-files-tool",
      `    command: ${JSON.stringify([process.execPath, "-e", assertion, "{changed_files}"])}`,
      "    run: changed_files",
      "",
    ].join("\n"),
  );
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

async function gitStdout(repoRoot: string, args: string[]): Promise<string> {
  const result = await runCommand("git", args, { cwd: repoRoot });

  if (result.code !== 0) {
    throw new Error(formatResult(result));
  }

  return result.stdout.trim();
}

async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<{
  code: number | null;
  stderr: string;
  stdout: string;
}> {
  return await new Promise<{
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

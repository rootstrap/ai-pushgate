import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import {
  buildLocalAiReviewPayload,
  parseAiReviewOutput,
  runLocalAiReview,
} from "../src/ai/index.js";
import { resolveChangedFiles } from "../src/path-policy/index.js";

test("parses structured AI review output into findings and summary", () => {
  const parsed = parseAiReviewOutput([
    "FINDING",
    "category: logic_errors",
    "severity: blocking",
    "file: src/changed.ts",
    "line: 3-4",
    "message: Conditional branch returns the wrong value.",
    "suggestion: Return the updated flag when the branch is taken.",
    "",
    "FINDING",
    "category: test_coverage",
    "severity: warning",
    "file: test/changed.test.ts",
    "line: N/A",
    "message: The new branch is not covered by a regression test.",
    "suggestion: Add a focused test for the branch.",
    "",
    "SUMMARY",
    "blocking_count: 1",
    "warning_count: 1",
    "verdict: BLOCK",
  ].join("\n"));

  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.findings[0]?.severity, "blocking");
  assert.equal(parsed.summary.blockingCount, 1);
  assert.equal(parsed.summary.warningCount, 1);
  assert.equal(parsed.summary.verdict, "BLOCK");
});

test("builds a shared AI review payload with diff and full-file context", async () => {
  await withAiRepo(async (repoRoot) => {
    const changedFileResolution = await resolveChangedFiles({
      repoRoot,
      targetBranch: "main",
      ignorePaths: [],
    });

    const payload = await buildLocalAiReviewPayload({
      changedFileResolution,
      repoRoot,
      reviewConfig: {
        context_lines: 10,
        max_lines_for_full_file: 300,
        target_branch: "main",
      },
    });

    assert.match(payload.prompt, /## Changed Files/);
    assert.match(payload.prompt, /=== DIFF ===/);
    assert.match(payload.prompt, /src\/changed\.ts/);
    assert.match(payload.prompt, /### FILE: src\/changed\.ts/);
    assert.match(payload.prompt, /export const changed = true/);
    assert.doesNotMatch(payload.prompt, /### FILE: src\/deleted\.ts/);
    assert.ok(payload.diffLineCount > 0);
    assert.ok(payload.fullFiles.length > 0);
  });
});

test("runs the Claude adapter through the provider interface with model selection", async () => {
  await withAiRepo(async (repoRoot) => {
    const binDir = join(repoRoot, "bin");
    const argsPath = join(repoRoot, "claude-args.txt");
    const promptPath = join(repoRoot, "claude-prompt.txt");
    const output = captureOutput();

    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "claude"),
      [
        "#!/usr/bin/env bash",
        "set -eu",
        "printf '%s\\n' \"$@\" > \"$PUSHGATE_CLAUDE_ARGS_OUT\"",
        "cat > \"$PUSHGATE_CLAUDE_PROMPT_OUT\"",
        "cat <<'EOF'",
        "SUMMARY",
        "blocking_count: 0",
        "warning_count: 0",
        "verdict: PASS",
        "EOF",
      ].join("\n"),
    );
    await chmod(join(binDir, "claude"), 0o755);

    const changedFileResolution = await resolveChangedFiles({
      repoRoot,
      targetBranch: "main",
      ignorePaths: [],
    });
    const result = await runLocalAiReview({
      aiConfig: {
        mode: "blocking",
        max_changed_lines: 500,
        max_prompt_tokens: 12_000,
        timeout_seconds: 120,
        provider: "claude",
        providers: {
          claude: {
            model: "claude-sonnet-4-20250514",
          },
        },
      },
      changedFileResolution,
      env: {
        ...process.env,
        PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
        PUSHGATE_CLAUDE_ARGS_OUT: argsPath,
        PUSHGATE_CLAUDE_PROMPT_OUT: promptPath,
      },
      repoRoot,
      reviewConfig: {
        context_lines: 10,
        max_lines_for_full_file: 300,
        target_branch: "main",
      },
      stdout: output.stream,
    });

    assert.equal(result.exitCode, 0, output.text());
    assert.match(output.text(), /Running local AI review with claude/);
    assert.match(output.text(), /Local AI review passed with no findings/);
    assert.match(await readFile(promptPath, "utf8"), /=== DIFF ===/);
    assert.deepEqual(await readArgLines(argsPath), [
      "-p",
      "Review the provided Pushgate review input exactly as instructed.",
      "--output-format",
      "text",
      "--bare",
      "--tools",
      "Read",
      "--allowedTools",
      "Read",
      "--permission-mode",
      "bypassPermissions",
      "--no-session-persistence",
      "--add-dir",
      repoRoot,
      "--model",
      "claude-sonnet-4-20250514",
    ]);
  });
});

test("skips local AI before provider invocation when changed-line guardrail is exceeded", async () => {
  await withAiRepo(async (repoRoot) => {
    const changedFileResolution = await resolveChangedFiles({
      repoRoot,
      targetBranch: "main",
      ignorePaths: [],
    });
    const output = captureOutput();
    const result = await runLocalAiReview({
      aiConfig: {
        mode: "blocking",
        max_changed_lines: 1,
        max_prompt_tokens: 12_000,
        timeout_seconds: 120,
        provider: "claude",
        providers: {
          claude: {},
        },
      },
      changedFileResolution,
      repoRoot,
      reviewConfig: {
        context_lines: 10,
        max_lines_for_full_file: 300,
        target_branch: "main",
      },
      stdout: output.stream,
    });

    assert.equal(result.exitCode, 0, output.text());
    assert.match(output.text(), /Skipping local AI because \d+ changed line\(s\) exceed ai\.max_changed_lines 1/);
    assert.doesNotMatch(output.text(), /provider claude failed/);
  });
});

test("skips local AI after prompt rendering when prompt token guardrail is exceeded", async () => {
  await withAiRepo(async (repoRoot) => {
    const changedFileResolution = await resolveChangedFiles({
      repoRoot,
      targetBranch: "main",
      ignorePaths: [],
    });
    const output = captureOutput();
    const result = await runLocalAiReview({
      aiConfig: {
        mode: "blocking",
        max_changed_lines: 500,
        max_prompt_tokens: 1,
        timeout_seconds: 120,
        provider: "claude",
        providers: {
          claude: {},
        },
      },
      changedFileResolution,
      repoRoot,
      reviewConfig: {
        context_lines: 10,
        max_lines_for_full_file: 300,
        target_branch: "main",
      },
      stdout: output.stream,
    });

    assert.equal(result.exitCode, 0, output.text());
    assert.match(output.text(), /Skipping local AI because the rendered prompt is approximately \d+ token\(s\), exceeding ai\.max_prompt_tokens 1/);
    assert.doesNotMatch(output.text(), /provider claude failed/);
  });
});

test("passes configured timeout seconds to the Claude adapter", async () => {
  await withAiRepo(async (repoRoot) => {
    const binDir = join(repoRoot, "bin");
    const output = captureOutput();

    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "claude"),
      [
        "#!/usr/bin/env bash",
        "set -eu",
        "cat > /dev/null",
        "sleep 2",
      ].join("\n"),
    );
    await chmod(join(binDir, "claude"), 0o755);

    const changedFileResolution = await resolveChangedFiles({
      repoRoot,
      targetBranch: "main",
      ignorePaths: [],
    });
    const result = await runLocalAiReview({
      aiConfig: {
        mode: "blocking",
        max_changed_lines: 500,
        max_prompt_tokens: 12_000,
        timeout_seconds: 1,
        provider: "claude",
        providers: {
          claude: {},
        },
      },
      changedFileResolution,
      env: {
        ...process.env,
        PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
      },
      repoRoot,
      reviewConfig: {
        context_lines: 10,
        max_lines_for_full_file: 300,
        target_branch: "main",
      },
      stdout: output.stream,
    });

    assert.equal(result.exitCode, 1, output.text());
    assert.match(output.text(), /Claude Code CLI timed out after 1s/);
  });
});

async function withAiRepo(
  callback: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const repoRoot = await mkdtemp(join(tmpdir(), "pushgate-ai-"));

  try {
    await checkedRun("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: repoRoot,
    });
    await checkedRun("git", ["config", "user.email", "ai@example.test"], {
      cwd: repoRoot,
    });
    await checkedRun("git", ["config", "user.name", "Pushgate AI"], {
      cwd: repoRoot,
    });
    await writeRepoFile(repoRoot, "src/changed.ts", "export const base = true;\n");
    await writeRepoFile(repoRoot, "src/deleted.ts", "export const removeMe = true;\n");
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
      "export const changed = true;\nexport function reviewMe(flag: boolean) {\n  return flag;\n}\n",
    );
    await rm(join(repoRoot, "src", "deleted.ts"));
    await checkedRun("git", ["add", "--all"], { cwd: repoRoot });
    await checkedRun("git", ["commit", "--quiet", "-m", "feature"], {
      cwd: repoRoot,
    });

    await callback(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

async function checkedRun(
  command: string,
  args: string[],
  options: {
    cwd: string;
  },
): Promise<void> {
  const result = await new Promise<{
    code: number | null;
    stderr: string;
    stdout: string;
  }>((resolve, reject) => {
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
    throw new Error(
      [
        `${command} ${args.join(" ")} exited with ${String(result.code)}.`,
        `stdout:\n${result.stdout}`,
        `stderr:\n${result.stderr}`,
      ].join("\n"),
    );
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

async function readArgLines(path: string): Promise<string[]> {
  return (await readFile(path, "utf8")).trimEnd().split("\n");
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

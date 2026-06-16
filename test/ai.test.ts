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
import type { LocalAiReviewPayload } from "../src/ai/index.js";
import {
  evaluateChangedFileGuardrails,
  evaluatePromptGuardrail,
} from "../src/ai/guardrails.js";
import { copilotProvider } from "../src/ai/providers/copilot.js";
import { renderLocalAiTranscript } from "../src/ai/transcript.js";
import { buildLocalAiVerdict } from "../src/ai/verdict.js";
import { resolveChangedFiles } from "../src/path-policy/index.js";

test("parses structured AI review output into findings and summary", () => {
  const parsed = parseAiReviewOutput(
    JSON.stringify({
      schema_version: 1,
      findings: [
        {
          category: "logic_errors",
          confidence: "high",
          severity: "blocking",
          file: "src/changed.ts",
          line: "3-4",
          message: "Conditional branch returns the wrong value.",
          suggestion: "Return the updated flag when the branch is taken.",
        },
        {
          category: "test_coverage",
          confidence: "medium",
          severity: "warning",
          file: "test/changed.test.ts",
          line: "N/A",
          message: "The new branch is not covered by a regression test.",
          suggestion: "Add a focused test for the branch.",
        },
      ],
    }),
    {
      model: "claude-sonnet-4-20250514",
      provider: "claude",
    },
  );

  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.findings[0]?.category, "logic_errors");
  assert.equal(parsed.findings[0]?.confidence, "high");
  assert.equal(parsed.findings[0]?.severity, "blocking");
  assert.equal(parsed.findings[0]?.source.provider, "claude");
  assert.equal(parsed.findings[0]?.source.model, "claude-sonnet-4-20250514");
  assert.deepEqual(parsed.normalizationNotes, []);
  assert.equal(parsed.summary.blockingCount, 1);
  assert.equal(parsed.summary.warningCount, 1);
  assert.equal(parsed.summary.verdict, "BLOCK");
});

test("repairs fenced JSON output before validation", () => {
  const parsed = parseAiReviewOutput(
    [
      "Here is the review result:",
      "```json",
      JSON.stringify({
        schema_version: 1,
        findings: [],
      }),
      "```",
    ].join("\n"),
    {
      provider: "claude",
    },
  );

  assert.equal(parsed.findings.length, 0);
  assert.equal(parsed.summary.verdict, "PASS");
  assert.deepEqual(parsed.normalizationNotes, [
    "Extracted the review JSON from a fenced code block.",
  ]);
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
    assert.match(payload.prompt, /"schema_version": 1/);
    assert.match(payload.prompt, /"confidence": "high"/);
    assert.match(payload.prompt, /src\/changed\.ts/);
    assert.match(payload.prompt, /### FILE: src\/changed\.ts/);
    assert.match(payload.prompt, /export const changed = true/);
    assert.doesNotMatch(payload.prompt, /### FILE: src\/deleted\.ts/);
    assert.doesNotMatch(payload.prompt, /FINDING/);
    assert.ok(payload.diffLineCount > 0);
    assert.ok(payload.fullFiles.length > 0);
  });
});

test("evaluates local AI guardrails without provider stubs", () => {
  assert.deepEqual(
    evaluateChangedFileGuardrails({
      changedFiles: [],
      maxChangedLines: 10,
    }),
    { kind: "skip-no-files" },
  );
  assert.deepEqual(
    evaluateChangedFileGuardrails({
      changedFiles: [
        {
          additions: 7,
          binary: false,
          deletions: 4,
          path: "src/changed.ts",
          status: "modified",
        },
        {
          additions: null,
          binary: true,
          deletions: null,
          path: "assets/logo.png",
          status: "modified",
        },
      ],
      maxChangedLines: 10,
    }),
    {
      kind: "skip-changed-lines",
      changedLineCount: 11,
      maxChangedLines: 10,
    },
  );
  assert.deepEqual(
    evaluatePromptGuardrail({
      maxPromptTokens: 2,
      prompt: "123456789",
    }),
    {
      kind: "skip-prompt-tokens",
      estimatedPromptTokens: 3,
      maxPromptTokens: 2,
    },
  );
});

test("builds and renders local AI verdict output without provider execution", () => {
  const output = captureOutput();
  const verdict = buildLocalAiVerdict("advisory", {
    kind: "review",
    provider: "claude",
    findings: [
      {
        category: "logic_errors",
        confidence: "high",
        severity: "blocking",
        file: "src/changed.ts",
        line: "2",
        message: "The branch returns the wrong value.",
        source: {
          provider: "claude",
        },
        suggestion: "Return the value selected by the branch.",
      },
    ],
    normalizationNotes: ["Extracted the review JSON from a fenced code block."],
    rawOutput: "{\"schema_version\":1,\"findings\":[]}",
    summary: {
      blockingCount: 1,
      warningCount: 0,
      verdict: "BLOCK",
    },
  });

  assert.equal(verdict.exitCode, 0);
  renderLocalAiTranscript(verdict.transcriptEvents, output.stream);

  assert.match(
    output.text(),
    /Note: Extracted the review JSON from a fenced code block/,
  );
  assert.match(output.text(), /BLOCK AI logic_errors at src\/changed\.ts:2/);
  assert.match(output.text(), /Continuing because ai\.mode is advisory/);
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
        "{\"schema_version\":1,\"findings\":[]}",
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
    assert.match(await readFile(promptPath, "utf8"), /"schema_version": 1/);
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

test("runs the Copilot adapter with non-interactive stdin prompt and model selection", async () => {
  await withAiRepo(async (repoRoot) => {
    const binDir = join(repoRoot, "bin");
    const argsPath = join(repoRoot, "copilot-args.txt");
    const promptPath = join(repoRoot, "copilot-prompt.txt");

    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "copilot"),
      [
        "#!/usr/bin/env bash",
        "set -eu",
        "printf '%s\\n' \"$@\" > \"$PUSHGATE_COPILOT_ARGS_OUT\"",
        "cat > \"$PUSHGATE_COPILOT_PROMPT_OUT\"",
        "cat <<'EOF'",
        "{\"schema_version\":1,\"findings\":[{\"category\":\"performance\",\"confidence\":\"medium\",\"severity\":\"warning\",\"file\":\"src/changed.ts\",\"line\":\"2\",\"message\":\"The loop repeats work that can be cached.\",\"suggestion\":\"Cache the computed value before entering the loop.\"}]}",
        "EOF",
      ].join("\n"),
    );
    await chmod(join(binDir, "copilot"), 0o755);

    const result = await copilotProvider.runReview({
      env: {
        ...process.env,
        PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
        PUSHGATE_COPILOT_ARGS_OUT: argsPath,
        PUSHGATE_COPILOT_PROMPT_OUT: promptPath,
      },
      payload: minimalReviewPayload("Review this Pushgate payload.\n"),
      providerConfig: {
        model: "gpt-5.4",
      },
      repoRoot,
      timeoutSeconds: 120,
    });

    if (result.kind !== "review") {
      assert.fail(`Expected Copilot review result, got ${result.kind}.`);
    }

    assert.equal(result.provider, "copilot");
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.source.provider, "copilot");
    assert.equal(result.findings[0]?.source.model, "gpt-5.4");
    assert.equal(result.summary.warningCount, 1);
    assert.equal(await readFile(promptPath, "utf8"), "Review this Pushgate payload.\n");
    assert.deepEqual(await readArgLines(argsPath), [
      "-s",
      "--no-ask-user",
      "--stream=off",
      "--output-format=text",
      "--no-color",
      "--no-custom-instructions",
      "--no-remote",
      "--disable-builtin-mcps",
      "--available-tools=view,grep,glob",
      "--allow-tool=read",
      "--deny-tool=shell",
      "--deny-tool=write",
      "--deny-tool=url",
      "--model=gpt-5.4",
    ]);
  });
});

test("maps Copilot auth-like failures through advisory mode", async () => {
  await withAiRepo(async (repoRoot) => {
    const binDir = join(repoRoot, "bin");
    const output = captureOutput();

    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "copilot"),
      [
        "#!/usr/bin/env bash",
        "set -eu",
        "cat > /dev/null",
        "echo 'Authentication required. Run copilot login or set COPILOT_GITHUB_TOKEN.' >&2",
        "exit 1",
      ].join("\n"),
    );
    await chmod(join(binDir, "copilot"), 0o755);

    const changedFileResolution = await resolveChangedFiles({
      repoRoot,
      targetBranch: "main",
      ignorePaths: [],
    });
    const result = await runLocalAiReview({
      aiConfig: {
        mode: "advisory",
        max_changed_lines: 500,
        max_prompt_tokens: 12_000,
        timeout_seconds: 120,
        provider: "copilot",
        providers: {
          copilot: {},
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

    assert.equal(result.exitCode, 0, output.text());
    assert.match(output.text(), /WARN local AI provider copilot failed/);
    assert.match(output.text(), /not authenticated or cannot access Copilot/);
    assert.match(output.text(), /Continuing because ai\.mode is advisory/);
  });
});

test("reports missing Copilot CLI as a provider failure", async () => {
  await withAiRepo(async (repoRoot) => {
    const emptyBinDir = join(repoRoot, "empty-bin");

    await mkdir(emptyBinDir, { recursive: true });

    const result = await copilotProvider.runReview({
      env: {
        ...process.env,
        PATH: emptyBinDir,
      },
      payload: minimalReviewPayload(),
      providerConfig: {},
      repoRoot,
      timeoutSeconds: 120,
    });

    if (result.kind !== "provider-error") {
      assert.fail(`Expected Copilot provider error, got ${result.kind}.`);
    }

    assert.equal(result.code, "missing_binary");
    assert.match(result.message, /GitHub Copilot CLI was not found on PATH/);
  });
});

test("reports malformed Copilot output through the normalized parser", async () => {
  await withAiRepo(async (repoRoot) => {
    const binDir = join(repoRoot, "bin");

    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "copilot"),
      [
        "#!/usr/bin/env bash",
        "set -eu",
        "cat > /dev/null",
        "echo 'Here is a review, but not JSON.'",
      ].join("\n"),
    );
    await chmod(join(binDir, "copilot"), 0o755);

    const result = await copilotProvider.runReview({
      env: {
        ...process.env,
        PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
      },
      payload: minimalReviewPayload(),
      providerConfig: {},
      repoRoot,
      timeoutSeconds: 120,
    });

    if (result.kind !== "provider-error") {
      assert.fail(`Expected Copilot provider error, got ${result.kind}.`);
    }

    assert.equal(result.code, "invalid_output");
    assert.match(result.message, /malformed review output/);
    assert.match(result.detail ?? "", /failed to parse JSON/);
  });
});

test("passes configured timeout seconds to the Copilot adapter", async () => {
  await withAiRepo(async (repoRoot) => {
    const binDir = join(repoRoot, "bin");

    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "copilot"),
      [
        "#!/usr/bin/env bash",
        "set -eu",
        "cat > /dev/null",
        "sleep 2",
      ].join("\n"),
    );
    await chmod(join(binDir, "copilot"), 0o755);

    const result = await copilotProvider.runReview({
      env: {
        ...process.env,
        PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
      },
      payload: minimalReviewPayload(),
      providerConfig: {},
      repoRoot,
      timeoutSeconds: 1,
    });

    if (result.kind !== "provider-error") {
      assert.fail(`Expected Copilot provider error, got ${result.kind}.`);
    }

    assert.equal(result.code, "timed_out");
    assert.match(result.message, /timed out after 1s/);
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

function minimalReviewPayload(
  prompt: string = "Review this Pushgate payload.\n",
): LocalAiReviewPayload {
  return {
    changedFiles: [],
    diff: "",
    diffLineCount: 0,
    fullFiles: [],
    prompt,
  };
}

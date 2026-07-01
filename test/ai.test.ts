import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import {
  AI_REVIEW_FINDING_FIELD_PROMPT_DOCS,
  AI_REVIEW_FINDING_KEYS,
  AI_REVIEW_OUTPUT_EXAMPLE,
  AiReviewOutputError,
  AiReviewOutputSchema,
  BASE_REVIEW_PROMPT,
  buildLocalAiReviewPayload,
  collectLocalAiReviewContext,
  generateAiReviewOutputJsonSchema,
  normalizeAiReviewObject,
  parseAiReviewOutput,
  runLocalAiReview,
  validateAiReviewOutputContract,
} from "../src/ai/index.js";
import type { LocalAiReviewPayload } from "../src/ai/index.js";
import {
  evaluateChangedFileGuardrails,
  evaluatePromptGuardrail,
} from "../src/ai/guardrails.js";
import { resolveLocalAiProviderRuntime } from "../src/ai/provider-runtime.js";
import { createCommandProviderAdapter } from "../src/ai/providers/command-provider-adapter.js";
import { claudeProvider } from "../src/ai/providers/claude.js";
import { copilotProvider } from "../src/ai/providers/copilot.js";
import type { ProviderCommandResult } from "../src/ai/providers/run-provider-command.js";
import { buildLocalAiVerdict } from "../src/ai/verdict.js";
import type { LocalAiProviderAdapter } from "../src/ai/types.js";
import {
  isGitLocalEnvVar,
  sanitizeGitLocalEnv,
} from "../src/git/environment.js";
import { resolveChangedFiles } from "../src/path-policy/index.js";
import { createLocalAiTranscript } from "../src/transcript/index.js";

test("validates the canonical AI review contract with Zod", () => {
  const result = AiReviewOutputSchema.safeParse(canonicalAiReviewOutput());

  assert.equal(result.success, true);
});

test("reports readable contract diagnostics for invalid AI review output", () => {
  const cases = [
    {
      expected: {
        keyword: "required",
        path: "/findings/0",
      },
      value: {
        schema_version: 1,
        findings: [
          {
            category: "security",
            confidence: "high",
            severity: "blocking",
            line: "7",
            message: "Shell command construction uses user input.",
            suggestion: "Pass arguments without shell interpolation.",
          },
        ],
      },
    },
    {
      expected: {
        keyword: "additionalProperties",
        path: "/findings/0",
      },
      value: {
        ...canonicalAiReviewOutput(),
        findings: [
          {
            ...canonicalAiReviewOutput().findings[0],
            metadata: "not allowed",
          },
        ],
      },
    },
    {
      expected: {
        keyword: "enum",
        path: "/findings/0/category",
      },
      value: {
        ...canonicalAiReviewOutput(),
        findings: [
          {
            ...canonicalAiReviewOutput().findings[0],
            category: "security_and_logic",
          },
        ],
      },
    },
    {
      expected: {
        keyword: "minLength",
        path: "/findings/0/message",
      },
      value: {
        ...canonicalAiReviewOutput(),
        findings: [
          {
            ...canonicalAiReviewOutput().findings[0],
            message: "",
          },
        ],
      },
    },
    {
      expected: {
        keyword: "const",
        path: "/schema_version",
      },
      value: {
        ...canonicalAiReviewOutput(),
        schema_version: 2,
      },
    },
  ];

  for (const { expected, value } of cases) {
    const result = validateAiReviewOutputContract(value);

    assert.equal(result.valid, false);

    if (!result.valid) {
      assert.ok(
        result.errors.some(
          (error) =>
            error.keyword === expected.keyword &&
            error.instancePath === expected.path,
        ),
        JSON.stringify(result.errors),
      );
    }
  }
});

test("validates category severity semantics in the AI review contract", () => {
  const result = validateAiReviewOutputContract({
    ...canonicalAiReviewOutput(),
    findings: [
      {
        ...canonicalAiReviewOutput().findings[0],
        category: "security",
        severity: "warning",
      },
    ],
  });

  assert.equal(result.valid, false);

  if (!result.valid) {
    assert.deepEqual(result.errors, [
      {
        instancePath: "/findings/0/severity",
        keyword: "categorySeverity",
        message: 'Finding "security" must use severity "blocking".',
        params: {
          actualSeverity: "warning",
          category: "security",
          expectedSeverity: "blocking",
        },
      },
    ]);
  }
});

test("keeps checked-in AI review JSON Schema in sync with the Zod contract", async () => {
  assert.deepEqual(
    JSON.parse(await readFile("schemas/ai-review-output-v1.schema.json", "utf8")),
    generateAiReviewOutputJsonSchema(),
  );
});

test("keeps the prompt JSON example aligned with the Zod contract", () => {
  const promptExample = JSON.parse(extractFirstJsonFence(BASE_REVIEW_PROMPT));
  const parsed = AiReviewOutputSchema.safeParse(promptExample);
  const documentedFindingFields = [
    ...BASE_REVIEW_PROMPT.matchAll(/^- `([^`]+)`:/gm),
  ].map((match) => match[1] ?? "");

  assert.deepEqual(promptExample, AI_REVIEW_OUTPUT_EXAMPLE);
  assert.equal(parsed.success, true);
  assert.deepEqual(
    new Set(documentedFindingFields),
    new Set(AI_REVIEW_FINDING_KEYS),
  );
  assert.equal(documentedFindingFields.length, AI_REVIEW_FINDING_KEYS.length);
  assert.deepEqual(
    documentedFindingFields,
    AI_REVIEW_FINDING_FIELD_PROMPT_DOCS.map((field) => field.key),
  );
  assert.doesNotMatch(BASE_REVIEW_PROMPT, /\{\{AI_REVIEW_/);
});

test("normalizes parsed AI review objects for native structured providers", () => {
  const normalized = normalizeAiReviewObject({
    rawOutput: JSON.stringify(canonicalAiReviewOutput()),
    source: {
      model: "gpt-native-structured",
      provider: "openai",
    },
    value: canonicalAiReviewOutput(),
  });

  assert.equal(normalized.findings.length, 1);
  assert.equal(normalized.findings[0]?.source.provider, "openai");
  assert.equal(normalized.findings[0]?.source.model, "gpt-native-structured");
  assert.deepEqual(normalized.normalizationNotes, []);
  assert.equal(normalized.summary.blockingCount, 1);
  assert.equal(normalized.summary.verdict, "BLOCK");
});

test("repairs safe key damage in parsed AI review objects", () => {
  const normalized = normalizeAiReviewObject({
    source: {
      provider: "native-provider",
    },
    value: {
      "\n schema_version\t": 1,
      findings: [
        {
          category: "security",
          confidence: "high",
          severity: "blocking",
          "\n file": "src/unsafe.ts",
          line: "7",
          message: "Shell command construction uses user input.",
          suggestion: "Pass arguments without shell interpolation.",
        },
      ],
    },
  });

  assert.equal(normalized.findings[0]?.file, "src/unsafe.ts");
  assert.deepEqual(normalized.normalizationNotes, [
    "Normalized whitespace around AI review JSON property names.",
  ]);
});

test("rejects ambiguous key repair in parsed AI review objects", () => {
  const error = normalizeInvalidAiReviewObject({
    schema_version: 1,
    findings: [
      {
        category: "security",
        confidence: "high",
        severity: "blocking",
        file: "src/safe.ts",
        "\n file": "src/ambiguous.ts",
        line: "7",
        message: "Shell command construction uses user input.",
        suggestion: "Pass arguments without shell interpolation.",
      },
    ],
  });

  assert.match(error.diagnostics.join("\n"), /both resolve to "file"/);
});

test("marks current CLI provider structured-output capabilities", () => {
  assert.equal(claudeProvider.structuredOutputCapability, "native_json_schema");
  assert.equal(copilotProvider.structuredOutputCapability, "jsonl_transport");
});

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

test("repairs bullet-prefixed JSON output with raw newlines inside strings", () => {
  const parsed = parseAiReviewOutput(
    [
      "● { \"schema_version\": 1, \"findings\": [",
      "  {",
      '    "category": "security",',
      '    "confidence": "high",',
      '    "severity": "blocking",',
      '    "file": ".pushgate.yml",',
      '    "line": "18-19",',
      '    "message": "The forbidden path rules for .env files are root-scoped and can miss secrets',
      'committed in subdirectories (for example, config/.env or services/api/.env.prod).",',
      '    "suggestion": "Make these patterns recursive (for example **/.env and **/.env.*) so',
      'environment files are blocked anywhere in the repository."',
      "  }",
      "] }",
    ].join("\n"),
    {
      provider: "copilot",
    },
  );

  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0]?.category, "security");
  assert.equal(parsed.findings[0]?.severity, "blocking");
  assert.match(
    parsed.findings[0]?.message ?? "",
    /miss secrets\ncommitted in subdirectories/,
  );
  assert.deepEqual(parsed.normalizationNotes, [
    "Stripped a leading list marker before the review JSON.",
    "Escaped raw control characters inside JSON strings.",
  ]);
  assert.equal(parsed.summary.blockingCount, 1);
  assert.equal(parsed.summary.verdict, "BLOCK");
});

test("extracts the review JSON when surrounding prose also contains braces", () => {
  const parsed = parseAiReviewOutput(
    [
      "I checked an object-like example first: {not valid json}.",
      "Final review:",
      JSON.stringify({
        schema_version: 1,
        findings: [],
      }),
    ].join("\n"),
    {
      provider: "copilot",
    },
  );

  assert.equal(parsed.findings.length, 0);
  assert.equal(parsed.summary.verdict, "PASS");
  assert.deepEqual(parsed.normalizationNotes, [
    "Extracted the review JSON from surrounding provider prose.",
  ]);
});

test("repairs trailing commas before schema validation", () => {
  const parsed = parseAiReviewOutput(
    [
      "{",
      '  "schema_version": 1,',
      '  "findings": [',
      "    {",
      '      "category": "performance",',
      '      "confidence": "medium",',
      '      "severity": "warning",',
      '      "file": "src/cache.ts",',
      '      "line": "7",',
      '      "message": "The lookup repeats work that can be cached.",',
      '      "suggestion": "Cache the computed value before returning.",',
      "    },",
      "  ],",
      "}",
    ].join("\n"),
    {
      provider: "copilot",
    },
  );

  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0]?.category, "performance");
  assert.equal(parsed.summary.warningCount, 1);
  assert.equal(parsed.summary.verdict, "PASS");
  assert.deepEqual(parsed.normalizationNotes, [
    "Removed trailing commas from JSON objects/arrays.",
  ]);
});

test("repairs whitespace-corrupted review property names before validation", () => {
  const parsed = parseAiReviewOutput(
    JSON.stringify({
      "\n schema_version\t": 1,
      "findings\n": [
        {
          category: "security",
          confidence: "high",
          severity: "blocking",
          "\n  file": "scripts/demo_command_injection.py",
          line: "7",
          message: "Shell command construction uses user-controlled input.",
          suggestion: "Pass arguments without shell interpolation.",
        },
      ],
    }),
    {
      provider: "copilot",
    },
  );

  assert.equal(parsed.findings.length, 1);
  assert.equal(
    parsed.findings[0]?.file,
    "scripts/demo_command_injection.py",
  );
  assert.deepEqual(parsed.normalizationNotes, [
    "Normalized whitespace around AI review JSON property names.",
  ]);
  assert.equal(parsed.summary.blockingCount, 1);
});

test("repairs whitespace-corrupted review property names after unwrapping provider output", () => {
  const parsed = parseAiReviewOutput(
    JSON.stringify({
      review: {
        schema_version: 1,
        findings: [
          {
            category: "security",
            confidence: "high",
            severity: "blocking",
            "\n file": "scripts/demo_command_injection.py",
            line: "7",
            message: "Shell command construction uses user-controlled input.",
            suggestion: "Pass arguments without shell interpolation.",
          },
        ],
      },
    }),
    {
      provider: "copilot",
    },
  );

  assert.equal(parsed.findings.length, 1);
  assert.equal(
    parsed.findings[0]?.file,
    "scripts/demo_command_injection.py",
  );
  assert.deepEqual(parsed.normalizationNotes, [
    'Normalized provider output from a top-level "review" wrapper.',
    "Normalized whitespace around AI review JSON property names.",
  ]);
});

test("rejects ambiguous whitespace-corrupted review property names", () => {
  const error = parseInvalidAiReviewOutput(
    JSON.stringify({
      schema_version: 1,
      findings: [
        {
          category: "security",
          confidence: "high",
          severity: "blocking",
          file: "src/safe.ts",
          "\n file": "src/ambiguous.ts",
          line: "7",
          message: "Shell command construction uses user-controlled input.",
          suggestion: "Pass arguments without shell interpolation.",
        },
      ],
    }),
  );

  assert.match(error.diagnostics.join("\n"), /both resolve to "file"/);
});

test("rejects unsupported review fields after key repair boundaries", () => {
  const misspelledKeyError = parseInvalidAiReviewOutput(
    JSON.stringify({
      schema_version: 1,
      findings: [
        {
          category: "security",
          confidence: "high",
          severity: "blocking",
          " file_name ": "src/unsafe.ts",
          line: "7",
          message: "Shell command construction uses user-controlled input.",
          suggestion: "Pass arguments without shell interpolation.",
        },
      ],
    }),
  );
  const misspelledDiagnostics = misspelledKeyError.diagnostics.join("\n");

  assert.match(misspelledDiagnostics, /missing required property "file"/);
  assert.match(misspelledDiagnostics, /unsupported property " file_name "/);

  const nestedExtraError = parseInvalidAiReviewOutput(
    JSON.stringify({
      schema_version: 1,
      findings: [
        {
          category: "security",
          confidence: "high",
          severity: "blocking",
          file: "src/unsafe.ts",
          line: "7",
          message: "Shell command construction uses user-controlled input.",
          metadata: {
            "\n file": "src/nested.ts",
          },
          suggestion: "Pass arguments without shell interpolation.",
        },
      ],
    }),
  );

  assert.match(
    nestedExtraError.diagnostics.join("\n"),
    /unsupported property "metadata"/,
  );
});

test("rejects category and severity mismatches as semantic review errors", () => {
  const blockingCategoryError = parseInvalidAiReviewOutput(
    JSON.stringify({
      ...canonicalAiReviewOutput(),
      findings: [
        {
          ...canonicalAiReviewOutput().findings[0],
          category: "security",
          severity: "warning",
        },
      ],
    }),
  );

  assert.match(
    blockingCategoryError.diagnostics.join("\n"),
    /Finding "security" must use severity "blocking"/,
  );

  const warningCategoryError = parseInvalidAiReviewOutput(
    JSON.stringify({
      ...canonicalAiReviewOutput(),
      findings: [
        {
          ...canonicalAiReviewOutput().findings[0],
          category: "performance",
          severity: "blocking",
        },
      ],
    }),
  );

  assert.match(
    warningCategoryError.diagnostics.join("\n"),
    /Finding "performance" must use severity "warning"/,
  );
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

test("collects local AI diff context from the resolved review range", async () => {
  await withAiRepo(async (repoRoot) => {
    const changedFileResolution = await resolveChangedFiles({
      repoRoot,
      targetBranch: "main",
      ignorePaths: [],
    });

    const context = await collectLocalAiReviewContext({
      changedFileResolution: {
        ...changedFileResolution,
        reviewRange: "HEAD",
      },
      repoRoot,
      reviewConfig: {
        context_lines: 10,
        max_lines_for_full_file: 300,
        target_branch: "main",
      },
    });

    assert.equal(context.diff, "");
  });
});

test("collects local AI review context for omitted, truncated, and missing files", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "pushgate-ai-context-"));

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
    await writeRepoFile(repoRoot, "README.md", "base\n");
    await checkedRun("git", ["add", "--all"], { cwd: repoRoot });
    await checkedRun("git", ["commit", "--quiet", "-m", "baseline"], {
      cwd: repoRoot,
    });
    await checkedRun("git", ["switch", "--quiet", "-c", "feature"], {
      cwd: repoRoot,
    });
    await writeRepoBytes(
      repoRoot,
      "assets/logo.bin",
      Uint8Array.from([0, 1, 2, 3, 0, 4]),
    );
    await writeRepoFile(repoRoot, "src/large.txt", "x".repeat(50 * 1024 + 1));
    await writeRepoFile(repoRoot, "src/missing.ts", "export const missing = true;\n");
    await checkedRun("git", ["add", "--all"], { cwd: repoRoot });
    await checkedRun("git", ["commit", "--quiet", "-m", "feature"], {
      cwd: repoRoot,
    });

    const changedFileResolution = await resolveChangedFiles({
      repoRoot,
      targetBranch: "main",
      ignorePaths: [],
    });
    await rm(join(repoRoot, "src", "missing.ts"));

    const context = await collectLocalAiReviewContext({
      changedFileResolution,
      repoRoot,
      reviewConfig: {
        context_lines: 10,
        max_lines_for_full_file: 300,
        target_branch: "main",
      },
    });
    const fullFilesByPath = new Map(
      context.fullFiles.map((file) => [file.path, file]),
    );

    assert.equal(
      fullFilesByPath.get("assets/logo.bin")?.note,
      "binary file omitted",
    );
    assert.equal(fullFilesByPath.get("assets/logo.bin")?.truncated, false);
    assert.equal(
      fullFilesByPath.get("src/large.txt")?.note,
      "truncated to 51200 bytes",
    );
    assert.equal(fullFilesByPath.get("src/large.txt")?.truncated, true);
    assert.match(
      fullFilesByPath.get("src/large.txt")?.content ?? "",
      /\n\.\.\. \[file truncated\]\n$/,
    );
    assert.equal(
      fullFilesByPath.get("src/missing.ts")?.note,
      "file disappeared before local AI review",
    );
    assert.equal(fullFilesByPath.get("src/missing.ts")?.content, "");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
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
      ],
      maxChangedLines: 10,
    }),
    {
      kind: "block-changed-lines",
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
  createLocalAiTranscript(output.stream).writeEvents(verdict.transcriptEvents);

  assert.match(
    output.text(),
    /Note: Extracted the review JSON from a fenced code block/,
  );
  assert.match(output.text(), /\[block\] AI logic errors\s+src\/changed\.ts:2/);
  assert.match(output.text(), /Continuing because ai\.mode is advisory/);
});

test("local AI provider runtime owns selection diagnostics and selected config", async () => {
  let selectedProviderConfig: unknown = null;
  const fakeProvider: LocalAiProviderAdapter = {
    displayName: "Fake",
    id: "fake",
    streamingCapability: "none",
    structuredOutputCapability: "text_fallback",
    async runReview(options) {
      selectedProviderConfig = options.providerConfig;

      return {
        kind: "review",
        provider: "fake",
        findings: [],
        normalizationNotes: [],
        rawOutput: "{\"schema_version\":1,\"findings\":[]}",
        summary: {
          blockingCount: 0,
          warningCount: 0,
          verdict: "PASS",
        },
      };
    },
  };
  const runtime = resolveLocalAiProviderRuntime(
    {
      mode: "blocking",
      verbose: true,
      max_changed_lines: 500,
      max_prompt_tokens: 12_000,
      timeout_seconds: 120,
      provider: "fake",
      providers: {
        fake: {
          model: "runtime-model",
        },
      },
    },
    [fakeProvider],
  );

  assert.equal(runtime.kind, "ready");

  if (runtime.kind !== "ready") {
    assert.fail("Expected provider runtime.");
  }

  assert.equal(runtime.providerId, "fake");
  assert.equal(
    (
      await runtime.runReview({
        env: {},
        payload: minimalReviewPayload(),
        repoRoot: process.cwd(),
        timeoutSeconds: 120,
      })
    ).kind,
    "review",
  );
  assert.deepEqual(selectedProviderConfig, {
    model: "runtime-model",
  });

  const unsupported = resolveLocalAiProviderRuntime(
    {
      mode: "blocking",
      verbose: true,
      max_changed_lines: 500,
      max_prompt_tokens: 12_000,
      timeout_seconds: 120,
      provider: "missing",
      providers: {
        missing: {},
      },
    },
    [fakeProvider],
  );

  assert.equal(unsupported.kind, "provider-error");

  if (unsupported.kind !== "provider-error") {
    assert.fail("Expected provider-error.");
  }

  assert.equal(unsupported.result.code, "unsupported_provider");
  assert.equal(unsupported.result.provider, "missing");
  assert.match(unsupported.result.message, /configured AI provider "missing"/);
});

test("command provider adapter maps shared command lifecycle outcomes", async () => {
  const successAdapter = createCommandProviderAdapter({
    id: "fake",
    displayName: "Fake",
    streamingCapability: "none",
    structuredOutputCapability: "text_fallback",
    command: "fake",
    buildInvocation() {
      return {
        args: ["review"],
        model: "fake-model",
      };
    },
    emptyOutputMessage: "Fake CLI returned an empty review response.",
    formatCommandFailedMessage(code) {
      return `Fake CLI exited with code ${String(code)}.`;
    },
    formatTimeoutMessage(timeoutSeconds) {
      return `Fake CLI timed out after ${String(timeoutSeconds)}s.`;
    },
    invalidOutputMessage: "Fake CLI returned malformed review output.",
    missingBinaryMessage: "Fake CLI was not found on PATH.",
    extractReview(commandResult) {
      return {
        content: commandResult.stdout,
        kind: "text",
      };
    },
  }, {
    async runCommand() {
      return {
        code: 0,
        kind: "completed",
        output: "{\"schema_version\":1,\"findings\":[]}",
        stdout: "{\"schema_version\":1,\"findings\":[]}",
      };
    },
  });
  const success = await successAdapter.runReview({
    env: {},
    payload: minimalReviewPayload(),
    providerConfig: {},
    repoRoot: process.cwd(),
    timeoutSeconds: 120,
  });

  assert.equal(success.kind, "review");

  if (success.kind !== "review") {
    assert.fail("Expected review.");
  }

  assert.equal(success.provider, "fake");
  assert.equal(success.findings.length, 0);
  assert.equal(success.summary.verdict, "PASS");

  const missingBinary = await runFakeCommandProvider({
    kind: "spawn-error",
  });

  assert.equal(missingBinary.kind, "provider-error");

  if (missingBinary.kind !== "provider-error") {
    assert.fail("Expected provider-error.");
  }

  assert.equal(missingBinary.code, "missing_binary");
  assert.match(missingBinary.message, /not found on PATH/);

  const timedOut = await runFakeCommandProvider({
    kind: "timeout",
    output: "partial output",
  });

  assert.equal(timedOut.kind, "provider-error");

  if (timedOut.kind !== "provider-error") {
    assert.fail("Expected provider-error.");
  }

  assert.equal(timedOut.code, "timed_out");
  assert.equal(timedOut.output, "partial output");

  const failed = await runFakeCommandProvider({
    code: 42,
    kind: "completed",
    output: "provider exploded",
    stdout: "",
  });

  assert.equal(failed.kind, "provider-error");

  if (failed.kind !== "provider-error") {
    assert.fail("Expected provider-error.");
  }

  assert.equal(failed.code, "command_failed");
  assert.match(failed.message, /exited with code 42/);
  assert.equal(failed.output, "provider exploded");
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
        claudeStructuredOutputJson({
          schema_version: 1,
          findings: [],
        }),
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
        verbose: true,
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
        ...sanitizeGitLocalEnv(process.env),
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
      transcript: createLocalAiTranscript(output.stream),
    });

    assert.equal(result.exitCode, 0, output.text());
    assert.match(output.text(), /Provider: Claude/);
    assert.match(output.text(), /\[ok\] No findings/);
    assert.match(await readFile(promptPath, "utf8"), /=== DIFF ===/);
    assert.match(await readFile(promptPath, "utf8"), /"schema_version": 1/);
    const args = await readArgLines(argsPath);

    assert.deepEqual(args.slice(0, 8), [
      "-p",
      "Review the provided Pushgate review input exactly as instructed.",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--json-schema",
      args[7] ?? "",
    ]);
    assert.deepEqual(
      JSON.parse(args[7] ?? ""),
      generateAiReviewOutputJsonSchema(),
    );
    assert.deepEqual(args.slice(8), [
      "--safe-mode",
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

test("streams Claude response text before validated findings", async () => {
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
        "cat <<'EOF'",
        claudeStreamJsonOutput({
          deltas: [
            "Reviewing ",
            "\u001B[31mchanged files\u001B[0m...\n",
          ],
          structuredOutput: {
            schema_version: 1,
            findings: [],
          },
        }),
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
        verbose: true,
        max_changed_lines: 500,
        max_prompt_tokens: 12_000,
        timeout_seconds: 120,
        provider: "claude",
        providers: {
          claude: {},
        },
      },
      changedFileResolution,
      env: {
        ...sanitizeGitLocalEnv(process.env),
        PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
      },
      repoRoot,
      reviewConfig: {
        context_lines: 10,
        max_lines_for_full_file: 300,
        target_branch: "main",
      },
      transcript: createLocalAiTranscript(output.stream),
    });
    const text = output.text();

    assert.equal(result.exitCode, 0, text);
    assert.match(text, /Claude response\n  Reviewing changed files\.\.\./);
    assert.doesNotMatch(text, /\u001B\[/);
    assert.ok(
      text.indexOf("Claude response") < text.indexOf("Validated findings"),
      text,
    );
    assert.match(text, /Validated findings\n  \[ok\] No findings/);
  });
});

test("suppresses Claude response text when AI verbose mode is false", async () => {
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
        "cat <<'EOF'",
        claudeStreamJsonOutput({
          deltas: ["This should stay hidden."],
          structuredOutput: {
            schema_version: 1,
            findings: [],
          },
        }),
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
        verbose: false,
        max_changed_lines: 500,
        max_prompt_tokens: 12_000,
        timeout_seconds: 120,
        provider: "claude",
        providers: {
          claude: {},
        },
      },
      changedFileResolution,
      env: {
        ...sanitizeGitLocalEnv(process.env),
        PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
      },
      repoRoot,
      reviewConfig: {
        context_lines: 10,
        max_lines_for_full_file: 300,
        target_branch: "main",
      },
      transcript: createLocalAiTranscript(output.stream),
    });
    const text = output.text();

    assert.equal(result.exitCode, 0, text);
    assert.doesNotMatch(text, /Claude response/);
    assert.doesNotMatch(text, /This should stay hidden/);
    assert.match(text, /Validated findings\n  \[ok\] No findings/);
  });
});

test("lets Claude provider config opt into bare mode for API-key scripts", async () => {
  await withAiRepo(async (repoRoot) => {
    const binDir = join(repoRoot, "bin");
    const argsPath = join(repoRoot, "claude-args.txt");

    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "claude"),
      [
        "#!/usr/bin/env bash",
        "set -eu",
        "printf '%s\\n' \"$@\" > \"$PUSHGATE_CLAUDE_ARGS_OUT\"",
        "cat > /dev/null",
        "cat <<'EOF'",
        claudeStructuredOutputJson({
          schema_version: 1,
          findings: [],
        }),
        "EOF",
      ].join("\n"),
    );
    await chmod(join(binDir, "claude"), 0o755);

    const result = await claudeProvider.runReview({
      env: {
        ...sanitizeGitLocalEnv(process.env),
        PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
        PUSHGATE_CLAUDE_ARGS_OUT: argsPath,
      },
      payload: minimalReviewPayload(),
      providerConfig: {
        bare: true,
      },
      repoRoot,
      timeoutSeconds: 120,
    });

    if (result.kind !== "review") {
      assert.fail(`Expected Claude review result, got ${result.kind}.`);
    }

    const args = await readArgLines(argsPath);

    assert.ok(args.includes("--bare"));
    assert.equal(args.includes("--safe-mode"), false);
  });
});

test("sanitizes hook-local Git env before AI provider CLI commands", async () => {
  await withAiRepo(async (repoRoot) => {
    const binDir = join(repoRoot, "bin");
    const envPath = join(repoRoot, "provider-env.json");
    const victimRoot = join(repoRoot, "victim-repo");

    await mkdir(binDir, { recursive: true });
    await mkdir(victimRoot, { recursive: true });
    await checkedRun("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: victimRoot,
    });
    await writeFile(
      join(binDir, "claude"),
      [
        "#!/usr/bin/env node",
        "import { writeFileSync } from 'node:fs';",
        "const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('GIT_')));",
        "writeFileSync(process.env.PUSHGATE_PROVIDER_ENV_OUT, JSON.stringify(gitEnv));",
        "for await (const _chunk of process.stdin) {}",
        `process.stdout.write(${JSON.stringify(
          claudeStructuredOutputJson({
            schema_version: 1,
            findings: [],
          }),
        )});`,
      ].join("\n"),
    );
    await chmod(join(binDir, "claude"), 0o755);

    const result = await claudeProvider.runReview({
      env: {
        ...sanitizeGitLocalEnv(process.env),
        ...poisonedGitEnv(victimRoot),
        PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
        PUSHGATE_PROVIDER_ENV_OUT: envPath,
      },
      payload: minimalReviewPayload(),
      providerConfig: {},
      repoRoot,
      timeoutSeconds: 120,
    });

    assert.equal(result.kind, "review");

    const recorded = JSON.parse(await readFile(envPath, "utf8")) as Record<
      string,
      string
    >;

    assert.deepEqual(leakedGitLocalVars(recorded), []);
  });
});

test("runs the Claude adapter with native structured output and source metadata", async () => {
  await withAiRepo(async (repoRoot) => {
    const binDir = join(repoRoot, "bin");

    await mkdir(binDir, { recursive: true });
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
              category: "performance",
              confidence: "medium",
              severity: "warning",
              file: "src/changed.ts",
              line: "2",
              message: "The loop repeats work that can be cached.",
              suggestion: "Cache the computed value before entering the loop.",
            },
          ],
        }),
        "EOF",
      ].join("\n"),
    );
    await chmod(join(binDir, "claude"), 0o755);

    const result = await claudeProvider.runReview({
      env: {
        ...sanitizeGitLocalEnv(process.env),
        PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
      },
      payload: minimalReviewPayload("Review this Pushgate payload.\n"),
      providerConfig: {
        model: "claude-sonnet-4-20250514",
      },
      repoRoot,
      timeoutSeconds: 120,
    });

    if (result.kind !== "review") {
      assert.fail(`Expected Claude review result, got ${result.kind}.`);
    }

    assert.equal(result.provider, "claude");
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.source.provider, "claude");
    assert.equal(
      result.findings[0]?.source.model,
      "claude-sonnet-4-20250514",
    );
    assert.equal(result.summary.warningCount, 1);
    assert.match(result.rawOutput, /"structured_output"/);
  });
});

test("reports malformed Claude structured output JSON", async () => {
  await withAiRepo(async (repoRoot) => {
    const binDir = join(repoRoot, "bin");

    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "claude"),
      [
        "#!/usr/bin/env bash",
        "set -eu",
        "cat > /dev/null",
        "echo 'not json'",
      ].join("\n"),
    );
    await chmod(join(binDir, "claude"), 0o755);

    const result = await claudeProvider.runReview({
      env: {
        ...sanitizeGitLocalEnv(process.env),
        PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
      },
      payload: minimalReviewPayload(),
      providerConfig: {},
      repoRoot,
      timeoutSeconds: 120,
    });

    if (result.kind !== "provider-error") {
      assert.fail(`Expected Claude provider error, got ${result.kind}.`);
    }

    assert.equal(result.code, "malformed_transport");
    assert.match(result.message, /malformed structured review output/);
    assert.match(result.detail ?? "", /failed to parse JSON/);
  });
});

test("reports malformed Claude structured output envelopes", async () => {
  await withAiRepo(async (repoRoot) => {
    const binDir = join(repoRoot, "bin");
    const outputPath = join(repoRoot, "claude-output.json");
    const cases = [
      {
        detail: /expected top-level type "result"/,
        value: {
          subtype: "success",
          structured_output: {
            schema_version: 1,
            findings: [],
          },
        },
      },
      {
        detail: /did not include a top-level `subtype` string/,
        value: {
          type: "result",
          structured_output: {
            schema_version: 1,
            findings: [],
          },
        },
      },
    ];

    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "claude"),
      [
        "#!/usr/bin/env bash",
        "set -eu",
        "cat > /dev/null",
        "cat \"$PUSHGATE_CLAUDE_OUTPUT_FILE\"",
      ].join("\n"),
    );
    await chmod(join(binDir, "claude"), 0o755);

    for (const testCase of cases) {
      await writeFile(outputPath, JSON.stringify(testCase.value));

      const result = await claudeProvider.runReview({
        env: {
          ...sanitizeGitLocalEnv(process.env),
          PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
          PUSHGATE_CLAUDE_OUTPUT_FILE: outputPath,
        },
        payload: minimalReviewPayload(),
        providerConfig: {},
        repoRoot,
        timeoutSeconds: 120,
      });

      if (result.kind !== "provider-error") {
        assert.fail(`Expected Claude provider error, got ${result.kind}.`);
      }

      assert.equal(result.code, "malformed_transport");
      assert.match(result.message, /malformed structured review output/);
      assert.match(result.detail ?? "", testCase.detail);
    }
  });
});

test("reports invalid Claude structured review objects", async () => {
  await withAiRepo(async (repoRoot) => {
    const binDir = join(repoRoot, "bin");

    await mkdir(binDir, { recursive: true });
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
              category: "security",
              confidence: "high",
              severity: "blocking",
              line: "7",
              message: "Shell command construction uses user input.",
              suggestion: "Pass arguments without shell interpolation.",
            },
          ],
        }),
        "EOF",
      ].join("\n"),
    );
    await chmod(join(binDir, "claude"), 0o755);

    const result = await claudeProvider.runReview({
      env: {
        ...sanitizeGitLocalEnv(process.env),
        PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
      },
      payload: minimalReviewPayload(),
      providerConfig: {},
      repoRoot,
      timeoutSeconds: 120,
    });

    if (result.kind !== "provider-error") {
      assert.fail(`Expected Claude provider error, got ${result.kind}.`);
    }

    assert.equal(result.code, "invalid_output");
    assert.match(result.message, /malformed review output/);
    assert.match(result.detail ?? "", /missing required property "file"/);
  });
});

test("reports unsupported Claude structured-output mode", async () => {
  await withAiRepo(async (repoRoot) => {
    const binDir = join(repoRoot, "bin");

    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "claude"),
      [
        "#!/usr/bin/env bash",
        "set -eu",
        "if [ \"${1:-}\" = \"auth\" ] && [ \"${2:-}\" = \"status\" ]; then",
        "  exit 0",
        "fi",
        "cat > /dev/null",
        "echo 'error: unknown option --json-schema' >&2",
        "exit 1",
      ].join("\n"),
    );
    await chmod(join(binDir, "claude"), 0o755);

    const result = await claudeProvider.runReview({
      env: {
        ...sanitizeGitLocalEnv(process.env),
        PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
      },
      payload: minimalReviewPayload(),
      providerConfig: {},
      repoRoot,
      timeoutSeconds: 120,
    });

    if (result.kind !== "provider-error") {
      assert.fail(`Expected Claude provider error, got ${result.kind}.`);
    }

    assert.equal(result.code, "unsupported_structured_output");
    assert.match(result.message, /does not appear to support native structured output/);
  });
});

test("reports Claude auth failures before generic command failures", async () => {
  await withAiRepo(async (repoRoot) => {
    const binDir = join(repoRoot, "bin");

    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "claude"),
      [
        "#!/usr/bin/env bash",
        "set -eu",
        "if [ \"${1:-}\" = \"auth\" ] && [ \"${2:-}\" = \"status\" ]; then",
        "  exit 1",
        "fi",
        "cat > /dev/null",
        "echo 'please log in' >&2",
        "exit 1",
      ].join("\n"),
    );
    await chmod(join(binDir, "claude"), 0o755);

    const result = await claudeProvider.runReview({
      env: {
        ...sanitizeGitLocalEnv(process.env),
        PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
      },
      payload: minimalReviewPayload(),
      providerConfig: {},
      repoRoot,
      timeoutSeconds: 120,
    });

    if (result.kind !== "provider-error") {
      assert.fail(`Expected Claude provider error, got ${result.kind}.`);
    }

    assert.equal(result.code, "not_authenticated");
    assert.match(result.message, /not authenticated/);
  });
});

test("classifies Claude prompt-mode login output as an auth failure", async () => {
  await withAiRepo(async (repoRoot) => {
    const binDir = join(repoRoot, "bin");

    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "claude"),
      [
        "#!/usr/bin/env bash",
        "set -eu",
        "if [ \"${1:-}\" = \"auth\" ] && [ \"${2:-}\" = \"status\" ]; then",
        "  exit 0",
        "fi",
        "cat > /dev/null",
        "cat <<'EOF'",
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: true,
          result: "Not logged in - Please run /login",
        }),
        "EOF",
        "exit 1",
      ].join("\n"),
    );
    await chmod(join(binDir, "claude"), 0o755);

    const result = await claudeProvider.runReview({
      env: {
        ...sanitizeGitLocalEnv(process.env),
        PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
      },
      payload: minimalReviewPayload(),
      providerConfig: {},
      repoRoot,
      timeoutSeconds: 120,
    });

    if (result.kind !== "provider-error") {
      assert.fail(`Expected Claude provider error, got ${result.kind}.`);
    }

    assert.equal(result.code, "not_authenticated");
    assert.match(result.message, /complete `\/login`/);
    assert.match(result.output ?? "", /Not logged in/);
  });
});

test("reports generic Claude command failures", async () => {
  await withAiRepo(async (repoRoot) => {
    const binDir = join(repoRoot, "bin");

    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "claude"),
      [
        "#!/usr/bin/env bash",
        "set -eu",
        "if [ \"${1:-}\" = \"auth\" ] && [ \"${2:-}\" = \"status\" ]; then",
        "  exit 0",
        "fi",
        "cat > /dev/null",
        "echo 'provider exploded' >&2",
        "exit 42",
      ].join("\n"),
    );
    await chmod(join(binDir, "claude"), 0o755);

    const result = await claudeProvider.runReview({
      env: {
        ...sanitizeGitLocalEnv(process.env),
        PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
      },
      payload: minimalReviewPayload(),
      providerConfig: {},
      repoRoot,
      timeoutSeconds: 120,
    });

    if (result.kind !== "provider-error") {
      assert.fail(`Expected Claude provider error, got ${result.kind}.`);
    }

    assert.equal(result.code, "command_failed");
    assert.match(result.message, /exited with code 42/);
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
        copilotAssistantMessageJsonl(
          JSON.stringify({
            schema_version: 1,
            findings: [
              {
                category: "performance",
                confidence: "medium",
                severity: "warning",
                file: "src/changed.ts",
                line: "2",
                message: "The loop repeats work that can be cached.",
                suggestion: "Cache the computed value before entering the loop.",
              },
            ],
          }),
        ),
        "EOF",
      ].join("\n"),
    );
    await chmod(join(binDir, "copilot"), 0o755);

    const result = await copilotProvider.runReview({
      env: {
        ...sanitizeGitLocalEnv(process.env),
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
      "--output-format=json",
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

test("streams Copilot assistant messages on separate response lines", async () => {
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
        "cat <<'EOF'",
        copilotAssistantMessageJsonl("Reviewing changed files."),
        copilotAssistantMessageJsonl("Checking stream parser behavior."),
        copilotAssistantMessageJsonl(
          JSON.stringify({
            schema_version: 1,
            findings: [],
          }),
        ),
        "EOF",
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
        mode: "blocking",
        verbose: true,
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
        ...sanitizeGitLocalEnv(process.env),
        PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
      },
      repoRoot,
      reviewConfig: {
        context_lines: 10,
        max_lines_for_full_file: 300,
        target_branch: "main",
      },
      transcript: createLocalAiTranscript(output.stream),
    });
    const text = output.text();

    assert.equal(result.exitCode, 0, text);
    assert.match(
      text,
      /GitHub Copilot response\n  Reviewing changed files\.\n  Checking stream parser behavior\.\n\nValidated findings/,
    );
    assert.doesNotMatch(text, /schema_version/);
  });
});

test("parses Copilot JSONL output larger than the provider transcript tail", async () => {
  await withAiRepo(async (repoRoot) => {
    const binDir = join(repoRoot, "bin");

    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "copilot"),
      [
        "#!/usr/bin/env node",
        "process.stdin.resume();",
        "process.stdin.on('data', () => {});",
        "process.stdin.on('end', () => {",
        "  console.log(JSON.stringify({",
        "    type: 'assistant.reasoning',",
        "    data: { reasoningId: 'x'.repeat(140 * 1024), content: '' },",
        "  }));",
        "  console.log(JSON.stringify({",
        "    type: 'assistant.message',",
        "    data: {",
        "      messageId: 'msg-1',",
        "      phase: 'final_answer',",
        "      content: JSON.stringify({ schema_version: 1, findings: [] }),",
        "    },",
        "  }));",
        "});",
      ].join("\n"),
    );
    await chmod(join(binDir, "copilot"), 0o755);

    const result = await copilotProvider.runReview({
      env: {
        ...sanitizeGitLocalEnv(process.env),
        PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
      },
      payload: minimalReviewPayload(),
      providerConfig: {},
      repoRoot,
      timeoutSeconds: 120,
    });

    if (result.kind !== "review") {
      assert.fail(`Expected Copilot review result, got ${result.kind}.`);
    }

    assert.equal(result.findings.length, 0);
    assert.equal(result.summary.verdict, "PASS");
  });
});

test("runs the Copilot adapter when the provider wraps JSON in a list marker", async () => {
  await withAiRepo(async (repoRoot) => {
    const binDir = join(repoRoot, "bin");

    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "copilot"),
      [
        "#!/usr/bin/env bash",
        "set -eu",
        "cat > /dev/null",
        "cat <<'EOF'",
        copilotAssistantMessageJsonl(
          [
            "● { \"schema_version\": 1, \"findings\": [",
            "  {",
            "    \"category\": \"security\",",
            "    \"confidence\": \"high\",",
            "    \"severity\": \"blocking\",",
            "    \"file\": \".pushgate.yml\",",
            "    \"line\": \"18-19\",",
            "    \"message\": \"The forbidden path rules for .env files are root-scoped and can miss secrets",
            "committed in subdirectories (for example, config/.env or services/api/.env.prod).\",",
            "    \"suggestion\": \"Make these patterns recursive (for example **/.env and **/.env.*) so",
            "environment files are blocked anywhere in the repository.\"",
            "  }",
            "] }",
          ].join("\n"),
        ),
        "EOF",
      ].join("\n"),
    );
    await chmod(join(binDir, "copilot"), 0o755);

    const result = await copilotProvider.runReview({
      env: {
        ...sanitizeGitLocalEnv(process.env),
        PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
      },
      payload: minimalReviewPayload(),
      providerConfig: {},
      repoRoot,
      timeoutSeconds: 120,
    });

    if (result.kind !== "review") {
      assert.fail(`Expected Copilot review result, got ${result.kind}.`);
    }

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.category, "security");
    assert.deepEqual(result.normalizationNotes, [
      "Stripped a leading list marker before the review JSON.",
      "Escaped raw control characters inside JSON strings.",
    ]);
    assert.equal(result.summary.blockingCount, 1);
    assert.equal(result.summary.verdict, "BLOCK");
  });
});

test("runs the Copilot adapter when the provider emits a whitespace-corrupted finding key", async () => {
  await withAiRepo(async (repoRoot) => {
    const binDir = join(repoRoot, "bin");

    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "copilot"),
      [
        "#!/usr/bin/env bash",
        "set -eu",
        "cat > /dev/null",
        "cat <<'EOF'",
        copilotAssistantMessageJsonl(
          [
            '{"schema_version":1,"findings":[{"category":"security","confidence":"high","severity":"blocking","',
            '  file":"scripts/demo_command_injection.py","line":"7","message":"Shell command construction uses user-controlled input.","suggestion":"Pass arguments without shell interpolation."}]}',
          ].join("\n"),
        ),
        "EOF",
      ].join("\n"),
    );
    await chmod(join(binDir, "copilot"), 0o755);

    const result = await copilotProvider.runReview({
      env: {
        ...sanitizeGitLocalEnv(process.env),
        PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
      },
      payload: minimalReviewPayload(),
      providerConfig: {},
      repoRoot,
      timeoutSeconds: 120,
    });

    if (result.kind !== "review") {
      assert.fail(`Expected Copilot review result, got ${result.kind}.`);
    }

    assert.equal(result.findings.length, 1);
    assert.equal(
      result.findings[0]?.file,
      "scripts/demo_command_injection.py",
    );
    assert.deepEqual(result.normalizationNotes, [
      "Escaped raw control characters inside JSON strings.",
      "Normalized whitespace around AI review JSON property names.",
    ]);
    assert.equal(result.summary.blockingCount, 1);
    assert.equal(result.summary.verdict, "BLOCK");
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
        verbose: true,
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
        ...sanitizeGitLocalEnv(process.env),
        PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
      },
      repoRoot,
      reviewConfig: {
        context_lines: 10,
        max_lines_for_full_file: 300,
        target_branch: "main",
      },
      transcript: createLocalAiTranscript(output.stream),
    });

    assert.equal(result.exitCode, 0, output.text());
    assert.match(output.text(), /\[warn\] Copilot provider/);
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
        ...sanitizeGitLocalEnv(process.env),
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

test("reports malformed Copilot JSONL transport output", async () => {
  await withAiRepo(async (repoRoot) => {
    const binDir = join(repoRoot, "bin");

    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "copilot"),
      [
        "#!/usr/bin/env bash",
        "set -eu",
        "cat > /dev/null",
        "echo 'not jsonl'",
      ].join("\n"),
    );
    await chmod(join(binDir, "copilot"), 0o755);

    const result = await copilotProvider.runReview({
      env: {
        ...sanitizeGitLocalEnv(process.env),
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

    assert.equal(result.code, "malformed_transport");
    assert.match(result.message, /malformed JSONL transport output/);
    assert.match(result.detail ?? "", /JSONL line 1 failed to parse JSON/);
  });
});

test("reports missing final Copilot assistant response", async () => {
  await withAiRepo(async (repoRoot) => {
    const binDir = join(repoRoot, "bin");

    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "copilot"),
      [
        "#!/usr/bin/env bash",
        "set -eu",
        "cat > /dev/null",
        "cat <<'EOF'",
        JSON.stringify({
          type: "assistant.intent",
          data: {
            intent: "Reviewing changes",
          },
        }),
        JSON.stringify({
          type: "assistant.turn_end",
          data: {
            turnId: "1",
          },
        }),
        "EOF",
      ].join("\n"),
    );
    await chmod(join(binDir, "copilot"), 0o755);

    const result = await copilotProvider.runReview({
      env: {
        ...sanitizeGitLocalEnv(process.env),
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

    assert.equal(result.code, "missing_response");
    assert.match(result.message, /did not include a final assistant response/);
    assert.match(result.detail ?? "", /none contained assistant response content/);
  });
});

test("reports invalid Copilot final review content through the normalized parser", async () => {
  await withAiRepo(async (repoRoot) => {
    const binDir = join(repoRoot, "bin");

    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "copilot"),
      [
        "#!/usr/bin/env bash",
        "set -eu",
        "cat > /dev/null",
        "cat <<'EOF'",
        copilotAssistantMessageJsonl("Here is a review, but not JSON."),
        "EOF",
      ].join("\n"),
    );
    await chmod(join(binDir, "copilot"), 0o755);

    const result = await copilotProvider.runReview({
      env: {
        ...sanitizeGitLocalEnv(process.env),
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
        ...sanitizeGitLocalEnv(process.env),
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

test("blocks local AI before provider invocation when changed-line guardrail is exceeded", async () => {
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
        verbose: true,
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
      transcript: createLocalAiTranscript(output.stream),
    });

    assert.equal(result.exitCode, 1, output.text());
    assert.match(output.text(), /\[block\] Changed lines\s+\d+ changed lines exceed ai\.max_changed_lines 1/);
    assert.match(output.text(), /Local AI Review blocked the push/);
    assert.doesNotMatch(output.text(), /provider claude failed/);
  });
});

test("reports unsupported local AI providers through the public gate", async () => {
  const output = captureOutput();
  const result = await runLocalAiReview({
    aiConfig: {
      mode: "blocking",
      verbose: true,
      max_changed_lines: 500,
      max_prompt_tokens: 12_000,
      timeout_seconds: 120,
      provider: "openai",
      providers: {
        openai: {},
      },
    },
    changedFileResolution: {
      diffBase: "base",
      files: [
        {
          additions: 1,
          binary: false,
          deletions: 0,
          path: "src/changed.ts",
          status: "modified",
        },
      ],
      reviewRange: "target...HEAD",
      scanRange: "base..HEAD",
      targetCommit: "target",
      targetRef: "main",
    },
    repoRoot: process.cwd(),
    reviewConfig: {
      context_lines: 10,
      max_lines_for_full_file: 300,
      target_branch: "main",
    },
    transcript: createLocalAiTranscript(output.stream),
  });

  assert.equal(result.exitCode, 1, output.text());
  assert.match(output.text(), /\[block\] Openai provider/);
  assert.match(
    output.text(),
    /does not implement the configured AI provider "openai" yet/,
  );
  assert.match(output.text(), /Local AI Review is blocking in this repository/);
  assert.doesNotMatch(output.text(), /Provider: Openai/);
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
        verbose: true,
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
      transcript: createLocalAiTranscript(output.stream),
    });

    assert.equal(result.exitCode, 0, output.text());
    assert.match(output.text(), /\[skip\] Prompt budget\s+approximately \d+ tokens exceeds ai\.max_prompt_tokens 1/);
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
        verbose: true,
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
        ...sanitizeGitLocalEnv(process.env),
        PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
      },
      repoRoot,
      reviewConfig: {
        context_lines: 10,
        max_lines_for_full_file: 300,
        target_branch: "main",
      },
      transcript: createLocalAiTranscript(output.stream),
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

async function writeRepoFile(
  repoRoot: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const filePath = join(repoRoot, relativePath);

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

async function writeRepoBytes(
  repoRoot: string,
  relativePath: string,
  content: Uint8Array,
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

function parseInvalidAiReviewOutput(rawOutput: string): AiReviewOutputError {
  try {
    parseAiReviewOutput(rawOutput, {
      provider: "copilot",
    });
  } catch (error) {
    assert.ok(error instanceof AiReviewOutputError);
    return error;
  }

  assert.fail("Expected AI review output parsing to fail.");
}

function normalizeInvalidAiReviewObject(value: unknown): AiReviewOutputError {
  try {
    normalizeAiReviewObject({
      source: {
        provider: "native-provider",
      },
      value,
    });
  } catch (error) {
    assert.ok(error instanceof AiReviewOutputError);
    return error;
  }

  assert.fail("Expected AI review object normalization to fail.");
}

function canonicalAiReviewOutput(): {
  findings: Array<{
    category: "security";
    confidence: "high";
    file: string;
    line: string;
    message: string;
    severity: "blocking";
    suggestion: string;
  }>;
  schema_version: 1;
} {
  return {
    schema_version: 1,
    findings: [
      {
        category: "security",
        confidence: "high",
        severity: "blocking",
        file: "src/unsafe.ts",
        line: "7",
        message: "Shell command construction uses user input.",
        suggestion: "Pass arguments without shell interpolation.",
      },
    ],
  };
}

function extractFirstJsonFence(value: string): string {
  const match = value.match(/```json\s*([\s\S]*?)```/i);

  assert.ok(match?.[1], "Expected prompt to contain a fenced JSON example.");
  return match[1];
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

function claudeStreamJsonOutput(options: {
  deltas: readonly string[];
  structuredOutput: unknown;
}): string {
  return [
    ...options.deltas.map((text) =>
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: {
            type: "text_delta",
            text,
          },
        },
      }),
    ),
    claudeStructuredOutputJson(options.structuredOutput),
  ].join("\n");
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

async function runFakeCommandProvider(
  commandResult: ProviderCommandResult,
): Promise<Awaited<ReturnType<LocalAiProviderAdapter["runReview"]>>> {
  const adapter = createCommandProviderAdapter({
    id: "fake",
    displayName: "Fake",
    streamingCapability: "none",
    structuredOutputCapability: "text_fallback",
    command: "fake",
    buildInvocation() {
      return {
        args: ["review"],
      };
    },
    emptyOutputMessage: "Fake CLI returned an empty review response.",
    formatCommandFailedMessage(code) {
      return `Fake CLI exited with code ${String(code)}.`;
    },
    formatTimeoutMessage(timeoutSeconds) {
      return `Fake CLI timed out after ${String(timeoutSeconds)}s.`;
    },
    invalidOutputMessage: "Fake CLI returned malformed review output.",
    missingBinaryMessage: "Fake CLI was not found on PATH.",
    extractReview(result) {
      return {
        content: result.stdout,
        kind: "text",
      };
    },
  }, {
    async runCommand() {
      return commandResult;
    },
  });

  return adapter.runReview({
    env: {},
    payload: minimalReviewPayload(),
    providerConfig: {},
    repoRoot: process.cwd(),
    timeoutSeconds: 3,
  });
}

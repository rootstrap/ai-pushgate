import type { AiConfig, ReviewConfig } from "../config/index.js";
import type { ChangedFileResolution } from "../path-policy/index.js";
import {
  createLocalAiTranscript,
  type LocalAiTranscript,
  type LocalAiTranscriptEvent,
} from "../transcript/index.js";
import {
  evaluateChangedFileGuardrails,
  evaluatePromptGuardrail,
} from "./guardrails.js";
import { resolveLocalAiProviderRuntime } from "./provider-runtime.js";
import { buildLocalAiReviewPayload } from "./review-context.js";
import type { LocalAiProviderResult } from "./types.js";
import { buildLocalAiVerdict } from "./verdict.js";

export interface LocalAiRunSummary {
  exitCode: number;
  warningCount: number;
}

export async function runLocalAiReview(options: {
  aiConfig: AiConfig;
  changedFileResolution: ChangedFileResolution;
  env?: NodeJS.ProcessEnv;
  repoRoot: string;
  reviewConfig: ReviewConfig;
  transcript?: LocalAiTranscript;
}): Promise<LocalAiRunSummary> {
  const transcript =
    options.transcript ?? createLocalAiTranscript(process.stdout);
  const providerRuntime = resolveLocalAiProviderRuntime(options.aiConfig);

  if (providerRuntime.kind === "provider-error") {
    return renderVerdict(
      options.aiConfig.mode,
      providerRuntime.result,
      transcript,
    );
  }

  const changedFileGuardrail = evaluateChangedFileGuardrails({
    changedFiles: options.changedFileResolution.files,
    maxChangedLines: options.aiConfig.max_changed_lines,
  });

  if (changedFileGuardrail.kind !== "run") {
    transcript.writeEvents(
      transcriptEventsForChangedFileGuardrail(changedFileGuardrail),
    );
    return {
      exitCode: changedFileGuardrail.kind === "block-changed-lines" ? 1 : 0,
      warningCount: 0,
    };
  }

  const payload = await buildLocalAiReviewPayload({
    changedFileResolution: options.changedFileResolution,
    env: options.env,
    repoRoot: options.repoRoot,
    reviewConfig: options.reviewConfig,
  });
  const promptGuardrail = evaluatePromptGuardrail({
    maxPromptTokens: options.aiConfig.max_prompt_tokens,
    prompt: payload.prompt,
  });

  if (promptGuardrail.kind !== "run") {
    transcript.writeEvents(
      [
        {
          kind: "skip-prompt-tokens",
          estimatedPromptTokens: promptGuardrail.estimatedPromptTokens,
          maxPromptTokens: promptGuardrail.maxPromptTokens,
        },
      ],
    );
    return { exitCode: 0, warningCount: 0 };
  }

  transcript.writeEvents(
    [
      {
        kind: "review-start",
        providerId: providerRuntime.providerId,
        changedFileCount: payload.changedFiles.length,
      },
    ],
  );

  if (payload.fullFiles.length > 0) {
    transcript.writeEvents(
      [
        {
          kind: "full-file-context",
          diffLineCount: payload.diffLineCount,
          fullFileCount: payload.fullFiles.length,
        },
      ],
    );
  }

  return renderVerdict(
    options.aiConfig.mode,
    await providerRuntime.runReview({
      env: options.env ?? process.env,
      payload,
      repoRoot: options.repoRoot,
      timeoutSeconds: options.aiConfig.timeout_seconds,
    }),
    transcript,
  );
}

function renderVerdict(
  aiMode: AiConfig["mode"],
  result: LocalAiProviderResult,
  transcript: LocalAiTranscript,
): LocalAiRunSummary {
  const verdict = buildLocalAiVerdict(aiMode, result);
  transcript.writeEvents(verdict.transcriptEvents);
  return {
    exitCode: verdict.exitCode,
    warningCount: verdict.warningCount,
  };
}

function transcriptEventsForChangedFileGuardrail(
  decision: Exclude<
    ReturnType<typeof evaluateChangedFileGuardrails>,
    { kind: "run" }
  >,
): LocalAiTranscriptEvent[] {
  if (decision.kind === "skip-no-files") {
    return [{ kind: "skip-no-files" }];
  }

  return [
    {
      kind: "block-changed-lines",
      changedLineCount: decision.changedLineCount,
      maxChangedLines: decision.maxChangedLines,
    },
    { kind: "review-blocked" },
  ];
}

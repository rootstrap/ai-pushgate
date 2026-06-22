import type { AiConfig, ReviewConfig } from "../config/index.js";
import type { ChangedFileResolution } from "../path-policy/index.js";
import {
  evaluateChangedFileGuardrails,
  evaluatePromptGuardrail,
} from "./guardrails.js";
import { resolveProvider } from "./provider-registry.js";
import { buildLocalAiReviewPayload } from "./review-context.js";
import { renderLocalAiTranscript } from "./transcript.js";
import type {
  LocalAiProviderResult,
  LocalAiTranscriptEvent,
} from "./types.js";
import { buildLocalAiVerdict } from "./verdict.js";

export interface LocalAiRunSummary {
  exitCode: number;
}

export async function runLocalAiReview(options: {
  aiConfig: AiConfig;
  changedFileResolution: ChangedFileResolution;
  env?: NodeJS.ProcessEnv;
  repoRoot: string;
  reviewConfig: ReviewConfig;
  stdout?: NodeJS.WritableStream;
}): Promise<LocalAiRunSummary> {
  const stdout = options.stdout ?? process.stdout;
  const provider = resolveProvider(options.aiConfig.provider);

  if (provider === null) {
    return renderVerdict(
      options.aiConfig.mode,
      {
        kind: "provider-error",
        code: "unsupported_provider",
        provider: options.aiConfig.provider ?? "unknown",
        message: `Pushgate does not implement the configured AI provider ${JSON.stringify(options.aiConfig.provider)} yet.`,
      },
      stdout,
    );
  }

  const changedFileGuardrail = evaluateChangedFileGuardrails({
    changedFiles: options.changedFileResolution.files,
    maxChangedLines: options.aiConfig.max_changed_lines,
  });

  if (changedFileGuardrail.kind !== "run") {
    renderLocalAiTranscript(
      [transcriptEventForChangedFileGuardrail(changedFileGuardrail)],
      stdout,
    );
    return { exitCode: 0 };
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
    renderLocalAiTranscript(
      [
        {
          kind: "skip-prompt-tokens",
          estimatedPromptTokens: promptGuardrail.estimatedPromptTokens,
          maxPromptTokens: promptGuardrail.maxPromptTokens,
        },
      ],
      stdout,
    );
    return { exitCode: 0 };
  }

  renderLocalAiTranscript(
    [
      {
        kind: "review-start",
        providerId: provider.id,
        changedFileCount: payload.changedFiles.length,
      },
    ],
    stdout,
  );

  if (payload.fullFiles.length > 0) {
    renderLocalAiTranscript(
      [
        {
          kind: "full-file-context",
          diffLineCount: payload.diffLineCount,
          fullFileCount: payload.fullFiles.length,
        },
      ],
      stdout,
    );
  }

  return renderVerdict(
    options.aiConfig.mode,
    await provider.runReview({
      env: options.env ?? process.env,
      payload,
      providerConfig:
        options.aiConfig.providers[provider.id] ??
        options.aiConfig.providers[options.aiConfig.provider ?? provider.id] ??
        {},
      repoRoot: options.repoRoot,
      timeoutSeconds: options.aiConfig.timeout_seconds,
    }),
    stdout,
  );
}

function renderVerdict(
  aiMode: AiConfig["mode"],
  result: LocalAiProviderResult,
  stdout: NodeJS.WritableStream,
): LocalAiRunSummary {
  const verdict = buildLocalAiVerdict(aiMode, result);
  renderLocalAiTranscript(verdict.transcriptEvents, stdout);
  return { exitCode: verdict.exitCode };
}

function transcriptEventForChangedFileGuardrail(
  decision: Exclude<
    ReturnType<typeof evaluateChangedFileGuardrails>,
    { kind: "run" }
  >,
): LocalAiTranscriptEvent {
  if (decision.kind === "skip-no-files") {
    return { kind: "skip-no-files" };
  }

  return {
    kind: "skip-changed-lines",
    changedLineCount: decision.changedLineCount,
    maxChangedLines: decision.maxChangedLines,
  };
}

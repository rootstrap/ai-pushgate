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
import type {
  LocalAiProviderResult,
  LocalAiProviderStreamEvent,
} from "./types.js";
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
        providerLabel: providerRuntime.providerDisplayName,
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

  let providerResponseStarted = false;
  const responseTextRequested =
    options.aiConfig.verbose &&
    providerRuntime.streamingCapability === "human_response_and_final_result";

  transcript.writeEvents([
    {
      kind: "provider-wait-start",
      providerLabel: providerRuntime.providerDisplayName,
    },
  ]);

  return renderVerdict(
    options.aiConfig.mode,
    await providerRuntime.runReview({
      env: options.env ?? process.env,
      payload,
      repoRoot: options.repoRoot,
      streaming: {
        progress: true,
        responseText: responseTextRequested,
        onEvent(event) {
          providerResponseStarted = renderProviderStreamEvent({
            event,
            providerLabel: providerRuntime.providerDisplayName,
            responseTextRequested,
            responseStarted: providerResponseStarted,
            transcript,
          });
        },
      },
      timeoutSeconds: options.aiConfig.timeout_seconds,
    }),
    transcript,
  );
}

function renderProviderStreamEvent(options: {
  event: LocalAiProviderStreamEvent;
  providerLabel: string;
  responseStarted: boolean;
  responseTextRequested: boolean;
  transcript: LocalAiTranscript;
}): boolean {
  if (options.event.kind === "progress") {
    if (options.event.message.trim().length > 0) {
      options.transcript.writeEvents([
        {
          kind: "provider-wait-stop",
        },
        {
          kind: "provider-progress",
          message: options.event.message,
        },
      ]);
    }

    return options.responseStarted;
  }

  if (!options.responseTextRequested || options.event.text.length === 0) {
    return options.responseStarted;
  }

  if (!options.responseStarted) {
    options.transcript.writeEvents([
      {
        kind: "provider-wait-stop",
      },
      {
        kind: "provider-response-start",
        providerLabel: options.providerLabel,
      },
    ]);
  }

  options.transcript.writeEvents([
    {
      kind: "provider-response-delta",
      text: options.event.text,
    },
  ]);

  return true;
}

function renderVerdict(
  aiMode: AiConfig["mode"],
  result: LocalAiProviderResult,
  transcript: LocalAiTranscript,
): LocalAiRunSummary {
  const verdict = buildLocalAiVerdict(aiMode, result);
  transcript.writeEvents([
    { kind: "provider-wait-stop" },
    { kind: "validated-findings-start" },
  ]);
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

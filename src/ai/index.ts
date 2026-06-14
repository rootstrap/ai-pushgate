import type { AiConfig, ReviewConfig } from "../config/index.js";
import type { ChangedFileResolution } from "../path-policy/index.js";
import { buildLocalAiReviewPayload } from "./review-prompt.js";
import { claudeProvider } from "./providers/claude.js";
import type {
  LocalAiProviderAdapter,
  LocalAiProviderResult,
} from "./types.js";

export {
  BASE_REVIEW_PROMPT,
  buildLocalAiReviewPayload,
  renderLocalAiPrompt,
} from "./review-prompt.js";
export { AiReviewOutputError, parseAiReviewOutput } from "./review-output.js";
export type {
  AiFinding,
  AiFindingCategory,
  AiFindingConfidence,
  AiFindingSeverity,
  AiFindingSource,
  AiReviewSummary,
  LocalAiFullFileContext,
  LocalAiProviderAdapter,
  LocalAiProviderFailure,
  LocalAiProviderFailureCode,
  LocalAiProviderResult,
  LocalAiProviderReview,
  LocalAiReviewPayload,
  RawAiFinding,
  RawAiReviewOutput,
} from "./types.js";
export {
  AI_BLOCKING_CATEGORIES,
  AI_FINDING_CATEGORIES,
  AI_FINDING_CONFIDENCE_LEVELS,
  AI_REVIEW_OUTPUT_SCHEMA_VERSION,
  AI_WARNING_CATEGORIES,
} from "./types.js";

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
    return handleProviderResult(
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

  if (options.changedFileResolution.files.length === 0) {
    writeLine(stdout, "[pushgate] No changed files to review with local AI.");
    return { exitCode: 0 };
  }

  const changedLineCount = countChangedLines(
    options.changedFileResolution.files,
  );

  if (changedLineCount > options.aiConfig.max_changed_lines) {
    writeLine(
      stdout,
      `[pushgate] Skipping local AI because ${String(changedLineCount)} changed line(s) exceed ai.max_changed_lines ${String(options.aiConfig.max_changed_lines)}.`,
    );
    return { exitCode: 0 };
  }

  const payload = await buildLocalAiReviewPayload({
    changedFileResolution: options.changedFileResolution,
    env: options.env,
    repoRoot: options.repoRoot,
    reviewConfig: options.reviewConfig,
  });
  const estimatedPromptTokens = estimatePromptTokens(payload.prompt);

  if (estimatedPromptTokens > options.aiConfig.max_prompt_tokens) {
    writeLine(
      stdout,
      `[pushgate] Skipping local AI because the rendered prompt is approximately ${String(estimatedPromptTokens)} token(s), exceeding ai.max_prompt_tokens ${String(options.aiConfig.max_prompt_tokens)}.`,
    );
    return { exitCode: 0 };
  }

  writeLine(
    stdout,
    `[pushgate] Running local AI review with ${provider.id} on ${String(payload.changedFiles.length)} changed file(s).`,
  );

  if (payload.fullFiles.length > 0) {
    writeLine(
      stdout,
      `[pushgate] Local AI prompt includes ${String(payload.diffLineCount)} diff line(s) plus ${String(payload.fullFiles.length)} full file(s) for extra context.`,
    );
  }

  return handleProviderResult(
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

function resolveProvider(providerId?: string): LocalAiProviderAdapter | null {
  switch (providerId) {
    case "claude":
      return claudeProvider;
    default:
      return null;
  }
}

function handleProviderResult(
  aiMode: AiConfig["mode"],
  result: LocalAiProviderResult,
  stdout: NodeJS.WritableStream,
): LocalAiRunSummary {
  if (result.kind === "provider-error") {
    const label = aiMode === "advisory" ? "WARN" : "BLOCK";

    writeLine(
      stdout,
      `[pushgate] ${label} local AI provider ${result.provider} failed: ${result.message}`,
    );

    if (result.detail) {
      for (const line of result.detail.split("\n")) {
        writeLine(stdout, `[pushgate] Detail: ${line}`);
      }
    }

    if (result.output) {
      writeLine(stdout, "[pushgate] Provider output:");

      for (const line of result.output.split("\n")) {
        writeLine(stdout, `[pushgate]   ${line}`);
      }
    }

    if (aiMode === "advisory") {
      writeLine(
        stdout,
        "[pushgate] Continuing because ai.mode is advisory.",
      );
      return { exitCode: 0 };
    }

    writeLine(
      stdout,
      "[pushgate] Local AI is blocking in this repository. Fix the provider issue or use git -c pushgate.skip-ai-check=true push to bypass only the AI phase for one push.",
    );
    return { exitCode: 1 };
  }

  for (const note of result.normalizationNotes) {
    writeLine(stdout, `[pushgate] Note: ${note}`);
  }

  if (result.findings.length === 0) {
    writeLine(stdout, "[pushgate] Local AI review passed with no findings.");
  } else {
    for (const finding of result.findings) {
      const label = finding.severity === "blocking" ? "BLOCK" : "WARN";
      const location =
        finding.line === "N/A"
          ? finding.file
          : `${finding.file}:${finding.line}`;

      writeLine(
        stdout,
        `[pushgate] ${label} AI ${finding.category} at ${location}.`,
      );
      writeLine(stdout, `[pushgate]   Message: ${finding.message}`);
      writeLine(stdout, `[pushgate]   Suggestion: ${finding.suggestion}`);
    }
  }

  writeLine(
    stdout,
    `[pushgate] Local AI review finished: ${String(result.summary.blockingCount)} blocking finding(s), ${String(result.summary.warningCount)} warning(s).`,
  );

  if (result.summary.blockingCount === 0) {
    return { exitCode: 0 };
  }

  if (aiMode === "advisory") {
    writeLine(
      stdout,
      "[pushgate] Continuing because ai.mode is advisory.",
    );
    return { exitCode: 0 };
  }

  writeLine(
    stdout,
    "[pushgate] Local AI review blocked the push. Fix the findings above or use git -c pushgate.skip-ai-check=true push to bypass only the AI phase for one push.",
  );
  return { exitCode: 1 };
}

function writeLine(stream: NodeJS.WritableStream, line: string): void {
  stream.write(`${line}\n`);
}

function countChangedLines(
  changedFiles: ChangedFileResolution["files"],
): number {
  return changedFiles.reduce((total, file) => {
    if (file.binary) {
      return total;
    }

    return total + (file.additions ?? 0) + (file.deletions ?? 0);
  }, 0);
}

function estimatePromptTokens(prompt: string): number {
  if (prompt.length === 0) {
    return 0;
  }

  // Provider tokenizers vary, so keep this deliberately approximate and local.
  return Math.ceil(prompt.length / 4);
}

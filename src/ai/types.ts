import type { AiMode, ProviderConfig } from "../config/index.js";
import type { ChangedFile } from "../path-policy/index.js";

export const AI_REVIEW_OUTPUT_SCHEMA_VERSION = 1 as const;

export const AI_BLOCKING_CATEGORIES = [
  "security",
  "logic_errors",
] as const;

export const AI_WARNING_CATEGORIES = [
  "test_coverage",
  "performance",
  "naming_and_readability",
] as const;

export const AI_FINDING_CATEGORIES = [
  ...AI_BLOCKING_CATEGORIES,
  ...AI_WARNING_CATEGORIES,
] as const;

export const AI_FINDING_CONFIDENCE_LEVELS = [
  "low",
  "medium",
  "high",
] as const;

export type AiFindingSeverity = "blocking" | "warning";
export type AiFindingCategory = (typeof AI_FINDING_CATEGORIES)[number];
export type AiFindingConfidence = (typeof AI_FINDING_CONFIDENCE_LEVELS)[number];

export interface AiFindingSource {
  model?: string;
  provider: string;
}

export interface AiFinding {
  category: AiFindingCategory;
  confidence: AiFindingConfidence;
  severity: AiFindingSeverity;
  file: string;
  line: string;
  message: string;
  source: AiFindingSource;
  suggestion: string;
}

export interface AiReviewSummary {
  blockingCount: number;
  warningCount: number;
  verdict: "PASS" | "BLOCK";
}

export interface LocalAiFullFileContext {
  path: string;
  content: string;
  note?: string;
  truncated: boolean;
}

export interface LocalAiReviewContext {
  changedFiles: readonly ChangedFile[];
  diff: string;
  diffLineCount: number;
  fullFiles: readonly LocalAiFullFileContext[];
}

export interface LocalAiReviewPayload extends LocalAiReviewContext {
  prompt: string;
}

export type LocalAiProviderFailureCode =
  | "command_failed"
  | "empty_output"
  | "invalid_output"
  | "missing_binary"
  | "not_authenticated"
  | "timed_out"
  | "unsupported_provider";

export interface LocalAiProviderFailure {
  kind: "provider-error";
  code: LocalAiProviderFailureCode;
  provider: string;
  message: string;
  detail?: string;
  output?: string;
}

export interface LocalAiProviderReview {
  kind: "review";
  provider: string;
  findings: readonly AiFinding[];
  normalizationNotes: readonly string[];
  rawOutput: string;
  summary: AiReviewSummary;
}

export type LocalAiProviderResult =
  | LocalAiProviderFailure
  | LocalAiProviderReview;

export type LocalAiTranscriptEvent =
  | {
      kind: "skip-no-files";
    }
  | {
      kind: "skip-changed-lines";
      changedLineCount: number;
      maxChangedLines: number;
    }
  | {
      kind: "skip-prompt-tokens";
      estimatedPromptTokens: number;
      maxPromptTokens: number;
    }
  | {
      kind: "review-start";
      providerId: string;
      changedFileCount: number;
    }
  | {
      kind: "full-file-context";
      diffLineCount: number;
      fullFileCount: number;
    }
  | {
      kind: "provider-failure";
      aiMode: AiMode;
      result: LocalAiProviderFailure;
    }
  | {
      kind: "normalization-note";
      note: string;
    }
  | {
      kind: "review-passed";
    }
  | {
      kind: "finding";
      finding: AiFinding;
    }
  | {
      kind: "review-summary";
      summary: AiReviewSummary;
    }
  | {
      kind: "advisory-continue";
    }
  | {
      kind: "provider-blocked";
    }
  | {
      kind: "review-blocked";
    };

export interface LocalAiVerdict {
  exitCode: number;
  transcriptEvents: readonly LocalAiTranscriptEvent[];
}

export interface LocalAiProviderRunOptions {
  env: NodeJS.ProcessEnv;
  payload: LocalAiReviewPayload;
  providerConfig: ProviderConfig;
  repoRoot: string;
  timeoutSeconds: number;
}

export interface LocalAiProviderAdapter {
  id: string;
  runReview(
    options: LocalAiProviderRunOptions,
  ): Promise<LocalAiProviderResult>;
}

export interface RawAiFinding {
  category: AiFindingCategory;
  confidence: AiFindingConfidence;
  severity: AiFindingSeverity;
  file: string;
  line: string;
  message: string;
  suggestion: string;
}

export interface RawAiReviewOutput {
  findings: RawAiFinding[];
  schema_version: typeof AI_REVIEW_OUTPUT_SCHEMA_VERSION;
}

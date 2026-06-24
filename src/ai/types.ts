import type { AiMode, ProviderConfig } from "../config/index.js";
import type { ChangedFile } from "../path-policy/index.js";
import type {
  AiFindingCategory,
  AiFindingConfidence,
  AiFindingSeverity,
} from "./review-contract.js";

export {
  AI_BLOCKING_CATEGORIES,
  AI_REVIEW_CATEGORY_GROUPS,
  AI_REVIEW_FINDING_FIELD_PROMPT_DOCS,
  AI_FINDING_CATEGORIES,
  AI_FINDING_CONFIDENCE_LEVELS,
  AI_FINDING_SEVERITIES,
  AI_REVIEW_OUTPUT_EXAMPLE,
  AI_REVIEW_FINDING_KEYS,
  AI_REVIEW_OUTPUT_SCHEMA_ID,
  AI_REVIEW_OUTPUT_SCHEMA_TITLE,
  AI_REVIEW_OUTPUT_SCHEMA_VERSION,
  AI_REVIEW_TOP_LEVEL_KEYS,
  AI_WARNING_CATEGORIES,
} from "./review-contract.js";
export type {
  AiReviewFindingFieldPromptDoc,
  AiReviewFindingKey,
  AiReviewTopLevelKey,
  AiFindingCategory,
  AiFindingConfidence,
  AiFindingSeverity,
  RawAiFinding,
  RawAiReviewOutput,
} from "./review-contract.js";

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
  | "malformed_transport"
  | "missing_binary"
  | "missing_response"
  | "not_authenticated"
  | "timed_out"
  | "unsupported_structured_output"
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
      kind: "block-changed-lines";
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
  warningCount: number;
}

export interface LocalAiProviderRunOptions {
  env: NodeJS.ProcessEnv;
  payload: LocalAiReviewPayload;
  providerConfig: ProviderConfig;
  repoRoot: string;
  timeoutSeconds: number;
}

export type LocalAiProviderStructuredOutputCapability =
  | "native_json_schema"
  | "strict_tool_call"
  | "json_mode"
  | "jsonl_transport"
  | "text_fallback";

export interface LocalAiProviderAdapter {
  id: string;
  structuredOutputCapability: LocalAiProviderStructuredOutputCapability;
  runReview(
    options: LocalAiProviderRunOptions,
  ): Promise<LocalAiProviderResult>;
}

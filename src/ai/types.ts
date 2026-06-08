import type { ProviderConfig } from "../config/index.js";
import type { ChangedFile } from "../path-policy/index.js";

export type AiFindingSeverity = "blocking" | "warning";

export interface AiFinding {
  category: string;
  severity: AiFindingSeverity;
  file: string;
  line: string;
  message: string;
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

export interface LocalAiReviewPayload {
  changedFiles: readonly ChangedFile[];
  diff: string;
  diffLineCount: number;
  fullFiles: readonly LocalAiFullFileContext[];
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
  rawOutput: string;
  summary: AiReviewSummary;
}

export type LocalAiProviderResult =
  | LocalAiProviderFailure
  | LocalAiProviderReview;

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

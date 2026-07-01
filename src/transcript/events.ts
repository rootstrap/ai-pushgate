import type { AiConfig } from "../config/index.js";
import type {
  AiFinding,
  AiReviewSummary,
  LocalAiProviderFailure,
} from "../ai/types.js";

export type DeterministicTranscriptCheckStatus =
  | "passed"
  | "skipped"
  | "warning"
  | "blocked";

export interface DeterministicTranscriptCheckResult {
  label: string;
  status: DeterministicTranscriptCheckStatus;
  detail?: string;
  outputTail?: string;
}

export interface DeterministicTranscriptPlannedCheck {
  label: string;
  detail?: string;
}

export interface DeterministicTranscriptSummary {
  blockedCount: number;
  exitCode: number;
  warningCount: number;
}

export type LocalAiSkipReason = "local-ai-mode-off" | "skip-ai-check";

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
      providerLabel: string;
      changedFileCount: number;
    }
  | {
      kind: "full-file-context";
      diffLineCount: number;
      fullFileCount: number;
    }
  | {
      kind: "provider-progress";
      message: string;
    }
  | {
      kind: "provider-wait-start";
      providerLabel: string;
    }
  | {
      kind: "provider-wait-stop";
    }
  | {
      kind: "provider-response-start";
      providerLabel: string;
    }
  | {
      kind: "provider-response-delta";
      text: string;
    }
  | {
      kind: "provider-response-empty";
    }
  | {
      kind: "validated-findings-start";
    }
  | {
      kind: "provider-failure";
      aiMode: AiConfig["mode"];
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

export type WarningConfirmationPhase =
  | "deterministic checks"
  | "local AI review";

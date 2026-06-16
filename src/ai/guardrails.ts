import type { ChangedFileResolution } from "../path-policy/index.js";

export type ChangedFileGuardrailDecision =
  | {
      kind: "run";
      changedLineCount: number;
    }
  | {
      kind: "skip-no-files";
    }
  | {
      kind: "skip-changed-lines";
      changedLineCount: number;
      maxChangedLines: number;
    };

export type PromptGuardrailDecision =
  | {
      kind: "run";
      estimatedPromptTokens: number;
    }
  | {
      kind: "skip-prompt-tokens";
      estimatedPromptTokens: number;
      maxPromptTokens: number;
    };

export function evaluateChangedFileGuardrails(options: {
  changedFiles: ChangedFileResolution["files"];
  maxChangedLines: number;
}): ChangedFileGuardrailDecision {
  if (options.changedFiles.length === 0) {
    return { kind: "skip-no-files" };
  }

  const changedLineCount = countChangedLines(options.changedFiles);

  if (changedLineCount > options.maxChangedLines) {
    return {
      kind: "skip-changed-lines",
      changedLineCount,
      maxChangedLines: options.maxChangedLines,
    };
  }

  return {
    kind: "run",
    changedLineCount,
  };
}

export function evaluatePromptGuardrail(options: {
  maxPromptTokens: number;
  prompt: string;
}): PromptGuardrailDecision {
  const estimatedPromptTokens = estimatePromptTokens(options.prompt);

  if (estimatedPromptTokens > options.maxPromptTokens) {
    return {
      kind: "skip-prompt-tokens",
      estimatedPromptTokens,
      maxPromptTokens: options.maxPromptTokens,
    };
  }

  return {
    kind: "run",
    estimatedPromptTokens,
  };
}

export function countChangedLines(
  changedFiles: ChangedFileResolution["files"],
): number {
  return changedFiles.reduce((total, file) => {
    if (file.binary) {
      return total;
    }

    return total + (file.additions ?? 0) + (file.deletions ?? 0);
  }, 0);
}

export function estimatePromptTokens(prompt: string): number {
  if (prompt.length === 0) {
    return 0;
  }

  // Provider tokenizers vary, so keep this deliberately approximate and local.
  return Math.ceil(prompt.length / 4);
}

import type { ChangedFile } from "../path-policy/index.js";
import type { LocalAiFullFileContext } from "./types.js";
import reviewPromptMarkdown from "./prompts/review-prompt.md";

export const BASE_REVIEW_PROMPT = reviewPromptMarkdown;

export function renderLocalAiPrompt(options: {
  changedFiles: readonly ChangedFile[];
  diff: string;
  fullFiles: readonly LocalAiFullFileContext[];
}): string {
  const sections = [
    BASE_REVIEW_PROMPT.trimEnd(),
    "",
    "## Changed Files",
    formatChangedFiles(options.changedFiles),
    "",
    "=== DIFF ===",
    options.diff,
  ];

  if (options.fullFiles.length > 0) {
    sections.push("", "=== FILES ===", formatFullFiles(options.fullFiles));
  }

  return sections.join("\n").trimEnd() + "\n";
}

function formatChangedFiles(changedFiles: readonly ChangedFile[]): string {
  if (changedFiles.length === 0) {
    return "(none)";
  }

  return changedFiles
    .map((file) => `- ${file.path}${describeChangedFile(file)}`)
    .join("\n");
}

function describeChangedFile(file: ChangedFile): string {
  const details: string[] = [];

  if (file.status === "renamed" && file.previousPath) {
    details.push(`renamed from ${file.previousPath}`);
  } else if (file.status !== "modified") {
    details.push(file.status);
  }

  if (file.binary) {
    details.push("binary");
  } else if (file.additions !== null && file.deletions !== null) {
    details.push(`+${String(file.additions)}/-${String(file.deletions)}`);
  }

  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

function formatFullFiles(fullFiles: readonly LocalAiFullFileContext[]): string {
  return fullFiles
    .map((file) => {
      const title = file.note
        ? `### FILE: ${file.path} (${file.note})`
        : `### FILE: ${file.path}`;

      return [title, file.content].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

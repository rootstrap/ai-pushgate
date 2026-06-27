import {
  capitalize,
  formatCount,
  writeDetail,
  writeIndentedBlock,
  writeLine,
  writeResultRow,
} from "../terminal/format.js";
import type { LocalAiTranscriptEvent } from "./types.js";

export function renderLocalAiTranscript(
  events: readonly LocalAiTranscriptEvent[],
  stdout: NodeJS.WritableStream,
): void {
  for (const event of events) {
    renderLocalAiTranscriptEvent(event, stdout);
  }
}

function renderLocalAiTranscriptEvent(
  event: LocalAiTranscriptEvent,
  stdout: NodeJS.WritableStream,
): void {
  switch (event.kind) {
    case "skip-no-files":
      writeResultRow(stdout, "skipped", "No changed files to review");
      return;
    case "block-changed-lines":
      writeResultRow(
        stdout,
        "blocked",
        "Changed lines",
        `${String(event.changedLineCount)} changed lines exceed ai.max_changed_lines ${String(event.maxChangedLines)}`,
      );
      return;
    case "skip-prompt-tokens":
      writeResultRow(
        stdout,
        "skipped",
        "Prompt budget",
        `approximately ${String(event.estimatedPromptTokens)} tokens exceeds ai.max_prompt_tokens ${String(event.maxPromptTokens)}`,
      );
      return;
    case "review-start":
      writeDetail(stdout, `Provider: ${capitalize(event.providerId)}`);
      writeDetail(stdout, `Files reviewed: ${String(event.changedFileCount)}`);
      return;
    case "full-file-context":
      writeDetail(
        stdout,
        `Context: ${formatCount(event.diffLineCount, "diff line")} plus ${formatCount(event.fullFileCount, "full file")} for extra context`,
      );
      return;
    case "provider-failure": {
      const status = event.aiMode === "advisory" ? "warning" : "blocked";

      writeResultRow(
        stdout,
        status,
        `${capitalize(event.result.provider)} provider`,
        event.result.message,
      );

      if (event.result.detail) {
        writeDetail(stdout, "Detail:");
        writeIndentedBlock(stdout, event.result.detail.split("\n"));
      }

      if (event.result.output) {
        writeDetail(stdout, "Provider output:");
        writeIndentedBlock(stdout, event.result.output.split("\n"));
      }

      return;
    }
    case "normalization-note":
      writeDetail(stdout, `Note: ${event.note}`);
      return;
    case "review-passed":
      writeResultRow(stdout, "passed", "No findings");
      return;
    case "finding": {
      const status =
        event.finding.severity === "blocking" ? "blocked" : "warning";
      const location =
        event.finding.line === "N/A"
          ? event.finding.file
          : `${event.finding.file}:${event.finding.line}`;

      writeResultRow(
        stdout,
        status,
        `AI ${humanizeCategory(event.finding.category)}`,
        location,
      );
      writeDetail(stdout, `Message: ${event.finding.message}`);
      writeDetail(stdout, `Suggestion: ${event.finding.suggestion}`);
      return;
    }
    case "review-summary":
      if (
        event.summary.blockingCount > 0 ||
        event.summary.warningCount > 0
      ) {
        writeDetail(
          stdout,
          `Finished with ${formatCount(event.summary.blockingCount, "blocking finding")} and ${formatCount(event.summary.warningCount, "warning")}.`,
        );
      }
      return;
    case "advisory-continue":
      writeDetail(stdout, "Continuing because ai.mode is advisory.");
      return;
    case "provider-blocked":
      writeLine(stdout);
      writeLine(stdout, "Local AI is blocking in this repository.");
      writeLine(stdout, "Fix the provider issue, or use `git -c pushgate.skip-ai-check=true push` to bypass only the AI phase for one push.");
      return;
    case "review-blocked":
      writeLine(stdout);
      writeLine(stdout, "Local AI review blocked the push.");
      writeLine(stdout, "Fix the findings above, or use `git -c pushgate.skip-ai-check=true push` to bypass only the AI phase for one push.");
      return;
  }
}

function humanizeCategory(category: string): string {
  return category.replace(/_/g, " ");
}

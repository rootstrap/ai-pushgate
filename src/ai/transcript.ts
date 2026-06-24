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
      writeLine(stdout, "[pushgate] No changed files to review with local AI.");
      return;
    case "block-changed-lines":
      writeLine(
        stdout,
        `[pushgate] BLOCK local AI because ${String(event.changedLineCount)} changed line(s) exceed ai.max_changed_lines ${String(event.maxChangedLines)}.`,
      );
      return;
    case "skip-prompt-tokens":
      writeLine(
        stdout,
        `[pushgate] Skipping local AI because the rendered prompt is approximately ${String(event.estimatedPromptTokens)} token(s), exceeding ai.max_prompt_tokens ${String(event.maxPromptTokens)}.`,
      );
      return;
    case "review-start":
      writeLine(
        stdout,
        `[pushgate] Running local AI review with ${event.providerId} on ${String(event.changedFileCount)} changed file(s).`,
      );
      return;
    case "full-file-context":
      writeLine(
        stdout,
        `[pushgate] Local AI prompt includes ${String(event.diffLineCount)} diff line(s) plus ${String(event.fullFileCount)} full file(s) for extra context.`,
      );
      return;
    case "provider-failure": {
      const label = event.aiMode === "advisory" ? "WARN" : "BLOCK";

      writeLine(
        stdout,
        `[pushgate] ${label} local AI provider ${event.result.provider} failed: ${event.result.message}`,
      );

      if (event.result.detail) {
        for (const line of event.result.detail.split("\n")) {
          writeLine(stdout, `[pushgate] Detail: ${line}`);
        }
      }

      if (event.result.output) {
        writeLine(stdout, "[pushgate] Provider output:");

        for (const line of event.result.output.split("\n")) {
          writeLine(stdout, `[pushgate]   ${line}`);
        }
      }

      return;
    }
    case "normalization-note":
      writeLine(stdout, `[pushgate] Note: ${event.note}`);
      return;
    case "review-passed":
      writeLine(stdout, "[pushgate] Local AI review passed with no findings.");
      return;
    case "finding": {
      const label = event.finding.severity === "blocking" ? "BLOCK" : "WARN";
      const location =
        event.finding.line === "N/A"
          ? event.finding.file
          : `${event.finding.file}:${event.finding.line}`;

      writeLine(
        stdout,
        `[pushgate] ${label} AI ${event.finding.category} at ${location}.`,
      );
      writeLine(stdout, `[pushgate]   Message: ${event.finding.message}`);
      writeLine(stdout, `[pushgate]   Suggestion: ${event.finding.suggestion}`);
      return;
    }
    case "review-summary":
      writeLine(
        stdout,
        `[pushgate] Local AI review finished: ${String(event.summary.blockingCount)} blocking finding(s), ${String(event.summary.warningCount)} warning(s).`,
      );
      return;
    case "advisory-continue":
      writeLine(stdout, "[pushgate] Continuing because ai.mode is advisory.");
      return;
    case "provider-blocked":
      writeLine(
        stdout,
        "[pushgate] Local AI is blocking in this repository. Fix the provider issue or use git -c pushgate.skip-ai-check=true push to bypass only the AI phase for one push.",
      );
      return;
    case "review-blocked":
      writeLine(
        stdout,
        "[pushgate] Local AI review blocked the push. Fix the findings above or use git -c pushgate.skip-ai-check=true push to bypass only the AI phase for one push.",
      );
      return;
  }
}

function writeLine(stream: NodeJS.WritableStream, line: string): void {
  stream.write(`${line}\n`);
}

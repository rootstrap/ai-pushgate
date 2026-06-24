import type { AiConfig } from "../config/index.js";
import type {
  LocalAiProviderResult,
  LocalAiTranscriptEvent,
  LocalAiVerdict,
} from "./types.js";

export function buildLocalAiVerdict(
  aiMode: AiConfig["mode"],
  result: LocalAiProviderResult,
): LocalAiVerdict {
  if (result.kind === "provider-error") {
    const transcriptEvents: LocalAiTranscriptEvent[] = [
      {
        kind: "provider-failure",
        aiMode,
        result,
      },
    ];

    if (aiMode === "advisory") {
      transcriptEvents.push({ kind: "advisory-continue" });
      return {
        exitCode: 0,
        transcriptEvents,
        warningCount: 1,
      };
    }

    transcriptEvents.push({ kind: "provider-blocked" });
    return {
      exitCode: 1,
      transcriptEvents,
      warningCount: 0,
    };
  }

  const transcriptEvents: LocalAiTranscriptEvent[] = [];

  for (const note of result.normalizationNotes) {
    transcriptEvents.push({
      kind: "normalization-note",
      note,
    });
  }

  if (result.findings.length === 0) {
    transcriptEvents.push({ kind: "review-passed" });
  } else {
    for (const finding of result.findings) {
      transcriptEvents.push({
        kind: "finding",
        finding,
      });
    }
  }

  transcriptEvents.push({
    kind: "review-summary",
    summary: result.summary,
  });

  if (result.summary.blockingCount === 0) {
    return {
      exitCode: 0,
      transcriptEvents,
      warningCount: result.summary.warningCount,
    };
  }

  if (aiMode === "advisory") {
    transcriptEvents.push({ kind: "advisory-continue" });
    return {
      exitCode: 0,
      transcriptEvents,
      warningCount: result.summary.warningCount + result.summary.blockingCount,
    };
  }

  transcriptEvents.push({ kind: "review-blocked" });
  return {
    exitCode: 1,
    transcriptEvents,
    warningCount: result.summary.warningCount,
  };
}

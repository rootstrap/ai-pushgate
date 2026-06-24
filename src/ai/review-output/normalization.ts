import type {
  AiFinding,
  AiFindingSource,
  AiReviewSummary,
  RawAiFinding,
} from "../types.js";

export function normalizeFinding(
  finding: RawAiFinding,
  source: AiFindingSource,
): AiFinding {
  return {
    category: finding.category,
    confidence: finding.confidence,
    severity: finding.severity,
    file: finding.file,
    line: finding.line,
    message: finding.message,
    source: {
      provider: source.provider,
      ...(source.model ? { model: source.model } : {}),
    },
    suggestion: finding.suggestion,
  };
}

export function summarizeFindings(
  findings: readonly AiFinding[],
): AiReviewSummary {
  const blockingCount = findings.filter(
    (finding) => finding.severity === "blocking",
  ).length;
  const warningCount = findings.filter(
    (finding) => finding.severity === "warning",
  ).length;

  return {
    blockingCount,
    warningCount,
    verdict: blockingCount > 0 ? "BLOCK" : "PASS",
  };
}

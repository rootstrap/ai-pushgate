import {
  AI_BLOCKING_CATEGORIES,
  AI_WARNING_CATEGORIES,
} from "../review-contract.js";
import type {
  AiFinding,
  AiFindingSource,
  AiReviewSummary,
  RawAiFinding,
} from "../types.js";

const BLOCKING_CATEGORY_SET = new Set<string>(AI_BLOCKING_CATEGORIES);
const WARNING_CATEGORY_SET = new Set<string>(AI_WARNING_CATEGORIES);

export function validateFindingSemantics(
  findings: readonly RawAiFinding[],
): string[] {
  const diagnostics: string[] = [];

  for (const finding of findings) {
    if (
      BLOCKING_CATEGORY_SET.has(finding.category) &&
      finding.severity !== "blocking"
    ) {
      diagnostics.push(
        `Finding ${JSON.stringify(finding.category)} must use severity "blocking".`,
      );
    }

    if (
      WARNING_CATEGORY_SET.has(finding.category) &&
      finding.severity !== "warning"
    ) {
      diagnostics.push(
        `Finding ${JSON.stringify(finding.category)} must use severity "warning".`,
      );
    }
  }

  return diagnostics;
}

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

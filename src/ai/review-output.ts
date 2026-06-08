import type { AiFinding, AiReviewSummary } from "./types.js";

const FINDING_MARKER = "FINDING";
const SUMMARY_MARKER = "SUMMARY";

interface ParsedSummaryFields {
  blocking_count?: string;
  verdict?: string;
  warning_count?: string;
}

export class AiReviewOutputError extends Error {
  readonly diagnostics: string[];

  constructor(message: string, diagnostics: string[] = []) {
    super(message);
    this.name = new.target.name;
    this.diagnostics = diagnostics;
  }
}

export function parseAiReviewOutput(rawOutput: string): {
  findings: AiFinding[];
  summary: AiReviewSummary;
} {
  const findings: AiFinding[] = [];
  const lines = rawOutput.replace(/\r/g, "").split("\n");
  let currentFinding: Partial<AiFinding> | null = null;
  let inSummary = false;
  let parsedSummary: ParsedSummaryFields | null = null;

  const flushFinding = () => {
    if (currentFinding === null) {
      return;
    }

    findings.push(validateFinding(currentFinding));
    currentFinding = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line === "") {
      continue;
    }

    if (line === FINDING_MARKER) {
      if (inSummary) {
        throw new AiReviewOutputError(
          "Provider output is invalid: FINDING cannot appear after SUMMARY.",
        );
      }

      flushFinding();
      currentFinding = {};
      continue;
    }

    if (line === SUMMARY_MARKER) {
      if (parsedSummary !== null) {
        throw new AiReviewOutputError(
          "Provider output is invalid: SUMMARY appeared more than once.",
        );
      }

      flushFinding();
      inSummary = true;
      parsedSummary = {};
      continue;
    }

    const separatorIndex = line.indexOf(":");

    if (separatorIndex <= 0) {
      throw new AiReviewOutputError(
        `Provider output is invalid: expected key:value line, received ${JSON.stringify(line)}.`,
      );
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();

    if (value.length === 0) {
      throw new AiReviewOutputError(
        `Provider output is invalid: ${key} had an empty value.`,
      );
    }

    if (currentFinding !== null) {
      assignFindingField(currentFinding, key, value);
      continue;
    }

    if (inSummary && parsedSummary !== null) {
      assignSummaryField(parsedSummary, key, value);
      continue;
    }

    throw new AiReviewOutputError(
      `Provider output is invalid: ${JSON.stringify(line)} appeared outside a finding or summary block.`,
    );
  }

  flushFinding();

  if (parsedSummary === null) {
    throw new AiReviewOutputError(
      "Provider output is invalid: missing SUMMARY block.",
    );
  }

  const summary = validateSummary(parsedSummary, findings);

  return {
    findings,
    summary,
  };
}

function assignFindingField(
  finding: Partial<AiFinding>,
  key: string,
  value: string,
): void {
  switch (key) {
    case "category":
      finding.category = value;
      return;
    case "severity":
      finding.severity = value as AiFinding["severity"];
      return;
    case "file":
      finding.file = value;
      return;
    case "line":
      finding.line = value;
      return;
    case "message":
      finding.message = value;
      return;
    case "suggestion":
      finding.suggestion = value;
      return;
    default:
      throw new AiReviewOutputError(
        `Provider output is invalid: unexpected finding field ${JSON.stringify(key)}.`,
      );
  }
}

function assignSummaryField(
  summary: ParsedSummaryFields,
  key: string,
  value: string,
): void {
  switch (key) {
    case "blocking_count":
      summary.blocking_count = value;
      return;
    case "warning_count":
      summary.warning_count = value;
      return;
    case "verdict":
      summary.verdict = value;
      return;
    default:
      throw new AiReviewOutputError(
        `Provider output is invalid: unexpected summary field ${JSON.stringify(key)}.`,
      );
    }
}

function validateFinding(finding: Partial<AiFinding>): AiFinding {
  const missing = [
    "category",
    "severity",
    "file",
    "line",
    "message",
    "suggestion",
  ].filter(
    (field) =>
      !finding[field as keyof AiFinding] ||
      String(finding[field as keyof AiFinding]).trim().length === 0,
  );

  if (missing.length > 0) {
    throw new AiReviewOutputError(
      `Provider output is invalid: finding is missing ${missing.join(", ")}.`,
    );
  }

  if (finding.severity !== "blocking" && finding.severity !== "warning") {
    throw new AiReviewOutputError(
      `Provider output is invalid: severity must be "blocking" or "warning", received ${JSON.stringify(finding.severity)}.`,
    );
  }

  return {
    category: finding.category!,
    severity: finding.severity,
    file: finding.file!,
    line: finding.line!,
    message: finding.message!,
    suggestion: finding.suggestion!,
  };
}

function validateSummary(
  summary: ParsedSummaryFields,
  findings: readonly AiFinding[],
): AiReviewSummary {
  const blockingCount = parseCountField("blocking_count", summary.blocking_count);
  const warningCount = parseCountField("warning_count", summary.warning_count);

  if (summary.verdict !== "PASS" && summary.verdict !== "BLOCK") {
    throw new AiReviewOutputError(
      `Provider output is invalid: verdict must be "PASS" or "BLOCK", received ${JSON.stringify(summary.verdict)}.`,
    );
  }

  const actualBlockingCount = findings.filter(
    (finding) => finding.severity === "blocking",
  ).length;
  const actualWarningCount = findings.filter(
    (finding) => finding.severity === "warning",
  ).length;

  if (blockingCount !== actualBlockingCount) {
    throw new AiReviewOutputError(
      `Provider output is invalid: blocking_count ${String(blockingCount)} did not match ${String(actualBlockingCount)} parsed blocking finding(s).`,
    );
  }

  if (warningCount !== actualWarningCount) {
    throw new AiReviewOutputError(
      `Provider output is invalid: warning_count ${String(warningCount)} did not match ${String(actualWarningCount)} parsed warning finding(s).`,
    );
  }

  if ((summary.verdict === "BLOCK") !== (actualBlockingCount > 0)) {
    throw new AiReviewOutputError(
      `Provider output is invalid: verdict ${summary.verdict} did not match parsed blocking findings.`,
    );
  }

  return {
    blockingCount,
    warningCount,
    verdict: summary.verdict,
  };
}

function parseCountField(name: string, value: string | undefined): number {
  if (!value) {
    throw new AiReviewOutputError(
      `Provider output is invalid: missing ${name} in SUMMARY.`,
    );
  }

  if (!/^\d+$/.test(value)) {
    throw new AiReviewOutputError(
      `Provider output is invalid: ${name} must be an integer, received ${JSON.stringify(value)}.`,
    );
  }

  return Number.parseInt(value, 10);
}

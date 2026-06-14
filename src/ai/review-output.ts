import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

import schema from "../../schemas/ai-review-output-v1.schema.json" with {
  type: "json",
};

import {
  AI_BLOCKING_CATEGORIES,
  AI_WARNING_CATEGORIES,
  type AiFinding,
  type AiFindingSource,
  type AiReviewSummary,
  type RawAiFinding,
  type RawAiReviewOutput,
} from "./types.js";

interface ParsedCandidate {
  notes: string[];
  source: string;
  value: string;
}

const ajv = new Ajv({ allErrors: true, strict: true });
const validateSchema: ValidateFunction<RawAiReviewOutput> =
  ajv.compile<RawAiReviewOutput>(schema);

const BLOCKING_CATEGORY_SET = new Set<string>(AI_BLOCKING_CATEGORIES);
const WARNING_CATEGORY_SET = new Set<string>(AI_WARNING_CATEGORIES);

export class AiReviewOutputError extends Error {
  readonly diagnostics: string[];

  constructor(message: string, diagnostics: string[] = []) {
    super(message);
    this.name = new.target.name;
    this.diagnostics = diagnostics;
  }
}

export function parseAiReviewOutput(
  rawOutput: string,
  source: AiFindingSource,
): {
  findings: AiFinding[];
  normalizationNotes: string[];
  summary: AiReviewSummary;
} {
  const trimmedOutput = rawOutput.replace(/\r/g, "").trim();

  if (trimmedOutput.length === 0) {
    throw new AiReviewOutputError(
      "Provider output is invalid.",
      ["The provider response was empty after trimming whitespace."],
    );
  }

  const diagnostics: string[] = [];

  for (const candidate of buildCandidates(trimmedOutput)) {
    const rawReview = parseCandidate(candidate, diagnostics);

    if (rawReview === null) {
      continue;
    }

    const semanticDiagnostics = validateFindingSemantics(rawReview.findings);

    if (semanticDiagnostics.length > 0) {
      diagnostics.push(
        `${candidate.source}: ${semanticDiagnostics.join(" ")}`,
      );
      continue;
    }

    const findings = rawReview.findings.map((finding) =>
      normalizeFinding(finding, source),
    );

    return {
      findings,
      normalizationNotes: candidate.notes,
      summary: summarizeFindings(findings),
    };
  }

  throw new AiReviewOutputError(
    "Provider output is invalid.",
    diagnostics.length > 0
      ? dedupeDiagnostics(diagnostics)
      : ["The provider response did not contain a valid Pushgate review JSON object."],
  );
}

function parseCandidate(
  candidate: ParsedCandidate,
  diagnostics: string[],
): RawAiReviewOutput | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(candidate.value);
  } catch (error) {
    diagnostics.push(
      `${candidate.source}: failed to parse JSON (${formatUnknownError(error)}).`,
    );
    return null;
  }

  const directReview = validateParsedReview(parsed);

  if (directReview !== null) {
    return directReview;
  }

  const unwrapped = unwrapSingleNestedObject(parsed);

  if (unwrapped !== null) {
    const wrappedReview = validateParsedReview(unwrapped.value);

    if (wrappedReview !== null) {
      candidate.notes.push(
        `Normalized provider output from a top-level ${JSON.stringify(unwrapped.key)} wrapper.`,
      );
      return wrappedReview;
    }
  }

  diagnostics.push(
    `${candidate.source}: ${formatSchemaDiagnostics(validateSchema.errors ?? [])}`,
  );
  return null;
}

function validateParsedReview(parsed: unknown): RawAiReviewOutput | null {
  if (!validateSchema(parsed)) {
    return null;
  }

  return parsed;
}

function buildCandidates(output: string): ParsedCandidate[] {
  const seen = new Set<string>();
  const candidates: ParsedCandidate[] = [];

  const addCandidate = (value: string, source: string, notes: string[] = []) => {
    const trimmedValue = value.trim();

    if (trimmedValue.length === 0 || seen.has(trimmedValue)) {
      return;
    }

    seen.add(trimmedValue);
    candidates.push({
      notes,
      source,
      value: trimmedValue,
    });
  };

  addCandidate(output, "provider response");

  for (const fencedJson of extractFencedJsonBlocks(output)) {
    addCandidate(fencedJson, "fenced JSON block", [
      "Extracted the review JSON from a fenced code block.",
    ]);
  }

  const objectSlice = extractJsonObjectSlice(output);

  if (objectSlice !== null) {
    addCandidate(objectSlice, "embedded JSON object", [
      "Extracted the review JSON from surrounding provider prose.",
    ]);
  }

  return candidates;
}

function extractFencedJsonBlocks(output: string): string[] {
  const matches = output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);

  return [...matches].map((match) => match[1] ?? "");
}

function extractJsonObjectSlice(output: string): string | null {
  const firstBrace = output.indexOf("{");
  const lastBrace = output.lastIndexOf("}");

  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return null;
  }

  const sliced = output.slice(firstBrace, lastBrace + 1);

  return sliced === output ? null : sliced;
}

function unwrapSingleNestedObject(
  value: unknown,
): { key: string; value: unknown } | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const entries = Object.entries(value);

  if (entries.length !== 1) {
    return null;
  }

  const [key, nestedValue] = entries[0];

  return isPlainObject(nestedValue) ? { key, value: nestedValue } : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateFindingSemantics(findings: readonly RawAiFinding[]): string[] {
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

function normalizeFinding(
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

function summarizeFindings(findings: readonly AiFinding[]): AiReviewSummary {
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

function formatSchemaDiagnostics(errors: readonly ErrorObject[]): string {
  if (errors.length === 0) {
    return "The JSON object did not match the Pushgate review schema.";
  }

  return errors.map(formatSchemaError).join(" ");
}

function formatSchemaError(error: ErrorObject): string {
  const path = error.instancePath || "/";

  switch (error.keyword) {
    case "additionalProperties": {
      const property = String(error.params.additionalProperty);
      return `${path} includes unsupported property ${JSON.stringify(property)}.`;
    }
    case "const":
      return `${path} must equal 1 for schema_version.`;
    case "enum":
      return `${path} must be one of the allowed values.`;
    case "minLength":
      return `${path} must not be empty.`;
    case "required":
      return `${path} is missing required property ${JSON.stringify(String(error.params.missingProperty))}.`;
    case "type":
      return `${path} must be ${String(error.params.type)}.`;
    default:
      return `${path}: ${error.message ?? "failed validation"}.`;
  }
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dedupeDiagnostics(diagnostics: readonly string[]): string[] {
  return [...new Set(diagnostics)];
}

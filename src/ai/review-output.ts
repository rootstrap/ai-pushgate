import {
  AI_BLOCKING_CATEGORIES,
  AI_WARNING_CATEGORIES,
  type AiFinding,
  type AiFindingSource,
  type AiReviewSummary,
  type RawAiFinding,
  type RawAiReviewOutput,
} from "./types.js";
import {
  type SchemaValidationError,
  validateAiReviewOutput,
} from "../generated/ai-review-output-v1-validator.js";

interface ParsedCandidate {
  notes: string[];
  source: string;
  value: string;
}

interface ParsedReviewValidation {
  errors: readonly SchemaValidationError[];
  review: RawAiReviewOutput | null;
}

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
  const parsedJson = parseJsonCandidate(candidate);

  if (parsedJson.kind === "failure") {
    diagnostics.push(...parsedJson.diagnostics);
    return null;
  }

  candidate.notes.push(...parsedJson.notes);

  const directValidation = validateParsedReview(parsedJson.parsed);

  if (directValidation.review !== null) {
    return directValidation.review;
  }

  let schemaErrors = directValidation.errors;
  const unwrapped = unwrapSingleNestedObject(parsedJson.parsed);

  if (unwrapped !== null) {
    const wrappedValidation = validateParsedReview(unwrapped.value);

    if (wrappedValidation.review !== null) {
      candidate.notes.push(
        `Normalized provider output from a top-level ${JSON.stringify(unwrapped.key)} wrapper.`,
      );
      return wrappedValidation.review;
    }

    schemaErrors = wrappedValidation.errors;
  }

  diagnostics.push(
    `${candidate.source}: ${formatSchemaDiagnostics(schemaErrors)}`,
  );
  return null;
}

function parseJsonCandidate(
  candidate: ParsedCandidate,
):
  | {
      kind: "failure";
      diagnostics: string[];
    }
  | {
      kind: "success";
      notes: string[];
      parsed: unknown;
    } {
  const diagnostics: string[] = [];
  const attempts = [
    {
      notes: [] as string[],
      source: candidate.source,
      value: candidate.value,
    },
  ];
  const repairedCandidate = repairJsonCandidate(candidate.value);

  if (repairedCandidate !== null) {
    attempts.push({
      notes: repairedCandidate.notes,
      source: `${candidate.source} (normalized JSON)`,
      value: repairedCandidate.value,
    });
  }

  for (const attempt of attempts) {
    try {
      return {
        kind: "success",
        notes: attempt.notes,
        parsed: JSON.parse(attempt.value),
      };
    } catch (error) {
      diagnostics.push(
        `${attempt.source}: failed to parse JSON (${formatUnknownError(error)}).`,
      );
    }
  }

  return {
    kind: "failure",
    diagnostics,
  };
}

function validateParsedReview(parsed: unknown): ParsedReviewValidation {
  const schemaValidation = validateAiReviewOutput(parsed);

  if (!schemaValidation.valid) {
    return {
      errors: schemaValidation.errors ?? [],
      review: null,
    };
  }

  return {
    errors: [],
    review: parsed as RawAiReviewOutput,
  };
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

  for (const objectSlice of extractJsonObjectSlices(output)) {
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

function extractJsonObjectSlices(output: string): string[] {
  const slices: string[] = [];

  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== "{") {
      continue;
    }

    const endIndex = findJsonObjectEnd(output, index);

    if (endIndex === null) {
      continue;
    }

    const sliced = output.slice(index, endIndex + 1);

    if (sliced !== output) {
      slices.push(sliced);
    }
  }

  return slices;
}

function findJsonObjectEnd(value: string, startIndex: number): number | null {
  let depth = 0;
  let escaped = false;
  let inString = false;

  for (let index = startIndex; index < value.length; index += 1) {
    const character = value[index] ?? "";

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (character === "\\") {
        escaped = true;
        continue;
      }

      if (character === "\"") {
        inString = false;
      }

      continue;
    }

    if (character === "\"") {
      inString = true;
      continue;
    }

    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character === "}") {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  return null;
}

function repairJsonCandidate(
  value: string,
): { notes: string[]; value: string } | null {
  let repaired = value;
  const notes: string[] = [];

  const strippedListMarker = stripLeadingJsonListMarker(repaired);

  if (strippedListMarker !== repaired) {
    repaired = strippedListMarker;
    notes.push("Stripped a leading list marker before the review JSON.");
  }

  const escapedControlCharacters =
    escapeControlCharactersInJsonStrings(repaired);

  if (escapedControlCharacters !== repaired) {
    repaired = escapedControlCharacters;
    notes.push("Escaped raw control characters inside JSON strings.");
  }

  const removedTrailingCommas = removeTrailingCommasBeforeJsonClose(repaired);

  if (removedTrailingCommas !== repaired) {
    repaired = removedTrailingCommas;
    notes.push("Removed trailing commas from JSON objects/arrays.");
  }

  if (notes.length === 0) {
    return null;
  }

  return {
    notes,
    value: repaired,
  };
}

function stripLeadingJsonListMarker(value: string): string {
  return value.replace(/^\s*[•●▪◦*-]\s*(?=\{)/u, "");
}

function escapeControlCharactersInJsonStrings(value: string): string {
  let changed = false;
  let escaped = false;
  let inString = false;
  let repaired = "";

  for (const character of value) {
    if (!inString) {
      repaired += character;

      if (character === "\"") {
        inString = true;
      }

      continue;
    }

    if (escaped) {
      repaired += character;
      escaped = false;
      continue;
    }

    if (character === "\\") {
      repaired += character;
      escaped = true;
      continue;
    }

    if (character === "\"") {
      repaired += character;
      inString = false;
      continue;
    }

    if (character.charCodeAt(0) < 0x20) {
      changed = true;
      repaired += escapeJsonControlCharacter(character);
      continue;
    }

    repaired += character;
  }

  return changed ? repaired : value;
}

function escapeJsonControlCharacter(character: string): string {
  switch (character) {
    case "\b":
      return "\\b";
    case "\f":
      return "\\f";
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default:
      return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  }
}

function removeTrailingCommasBeforeJsonClose(value: string): string {
  let changed = false;
  let escaped = false;
  let inString = false;
  let repaired = "";

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";

    if (inString) {
      repaired += character;

      if (escaped) {
        escaped = false;
        continue;
      }

      if (character === "\\") {
        escaped = true;
        continue;
      }

      if (character === "\"") {
        inString = false;
      }

      continue;
    }

    if (character === "\"") {
      repaired += character;
      inString = true;
      continue;
    }

    if (character === ",") {
      const nextNonWhitespace = findNextNonJsonWhitespace(value, index + 1);

      if (
        nextNonWhitespace !== null &&
        ["]", "}"].includes(value[nextNonWhitespace] ?? "")
      ) {
        changed = true;
        continue;
      }
    }

    repaired += character;
  }

  return changed ? repaired : value;
}

function findNextNonJsonWhitespace(
  value: string,
  startIndex: number,
): number | null {
  for (let index = startIndex; index < value.length; index += 1) {
    const character = value[index] ?? "";

    if (![" ", "\n", "\r", "\t"].includes(character)) {
      return index;
    }
  }

  return null;
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

function formatSchemaDiagnostics(
  errors: readonly SchemaValidationError[],
): string {
  if (errors.length === 0) {
    return "The JSON object did not match the Pushgate review schema.";
  }

  return errors.map(formatSchemaError).join(" ");
}

function formatSchemaError(error: SchemaValidationError): string {
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

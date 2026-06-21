import {
  AI_BLOCKING_CATEGORIES,
  AI_REVIEW_FINDING_KEYS,
  AI_REVIEW_TOP_LEVEL_KEYS,
  AI_WARNING_CATEGORIES,
  type AiReviewContractValidationIssue,
  validateAiReviewOutputContract,
} from "./review-contract.js";
import {
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

export interface NormalizedAiReviewOutput {
  findings: AiFinding[];
  normalizationNotes: string[];
  summary: AiReviewSummary;
}

interface ParsedReviewValidation {
  errors: readonly AiReviewContractValidationIssue[];
  review: RawAiReviewOutput | null;
}

type ReviewKeyRepairResult =
  | {
      kind: "ambiguous";
      message: string;
    }
  | {
      kind: "success";
      notes: string[];
      value: unknown;
    };

type RepairedReviewValidation =
  | {
      kind: "ambiguous";
      message: string;
    }
  | {
      errors: readonly AiReviewContractValidationIssue[];
      kind: "invalid";
    }
  | {
      kind: "valid";
      notes: string[];
      review: RawAiReviewOutput;
    };

const BLOCKING_CATEGORY_SET = new Set<string>(AI_BLOCKING_CATEGORIES);
const FINDING_REVIEW_KEYS = new Set<string>(AI_REVIEW_FINDING_KEYS);
const KEY_REPAIR_NORMALIZATION_NOTE =
  "Normalized whitespace around AI review JSON property names.";
const TOP_LEVEL_REVIEW_KEYS = new Set<string>(AI_REVIEW_TOP_LEVEL_KEYS);
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
): NormalizedAiReviewOutput {
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

export function normalizeAiReviewObject(options: {
  rawOutput?: string;
  source: AiFindingSource;
  value: unknown;
}): NormalizedAiReviewOutput {
  const validation = validateRepairingReview(options.value);
  const diagnosticSource =
    options.rawOutput === undefined
      ? "provider response object"
      : "parsed provider response";

  if (validation.kind === "ambiguous") {
    throw new AiReviewOutputError(
      "Provider output is invalid.",
      [`${diagnosticSource}: ${validation.message}`],
    );
  }

  if (validation.kind === "invalid") {
    throw new AiReviewOutputError(
      "Provider output is invalid.",
      [`${diagnosticSource}: ${formatSchemaDiagnostics(validation.errors)}`],
    );
  }

  const semanticDiagnostics = validateFindingSemantics(
    validation.review.findings,
  );

  if (semanticDiagnostics.length > 0) {
    throw new AiReviewOutputError(
      "Provider output is invalid.",
      [`${diagnosticSource}: ${semanticDiagnostics.join(" ")}`],
    );
  }

  const findings = validation.review.findings.map((finding) =>
    normalizeFinding(finding, options.source),
  );

  return {
    findings,
    normalizationNotes: validation.notes,
    summary: summarizeFindings(findings),
  };
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

  const directValidation = validateRepairingReview(parsedJson.parsed);

  if (directValidation.kind === "ambiguous") {
    diagnostics.push(`${candidate.source}: ${directValidation.message}`);
    return null;
  }

  if (directValidation.kind === "valid") {
    candidate.notes.push(...directValidation.notes);
    return directValidation.review;
  }

  let schemaErrors = directValidation.errors;
  const unwrapped = unwrapSingleNestedObject(parsedJson.parsed);

  if (unwrapped !== null) {
    const wrappedValidation = validateRepairingReview(unwrapped.value);

    if (wrappedValidation.kind === "ambiguous") {
      diagnostics.push(`${candidate.source}: ${wrappedValidation.message}`);
      return null;
    }

    if (wrappedValidation.kind === "valid") {
      candidate.notes.push(
        `Normalized provider output from a top-level ${JSON.stringify(unwrapped.key)} wrapper.`,
      );
      candidate.notes.push(...wrappedValidation.notes);
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

function validateRepairingReview(parsed: unknown): RepairedReviewValidation {
  const repairedKeys = repairWhitespaceCorruptedReviewKeys(parsed);

  if (repairedKeys.kind === "ambiguous") {
    return repairedKeys;
  }

  const validation = validateParsedReview(repairedKeys.value);

  if (validation.review !== null) {
    return {
      kind: "valid",
      notes: repairedKeys.notes,
      review: validation.review,
    };
  }

  return {
    errors: validation.errors,
    kind: "invalid",
  };
}

function validateParsedReview(parsed: unknown): ParsedReviewValidation {
  const schemaValidation = validateAiReviewOutputContract(parsed);

  if (schemaValidation.valid) {
    return {
      errors: [],
      review: schemaValidation.data,
    };
  }

  return {
    errors: schemaValidation.errors,
    review: null,
  };
}

function repairWhitespaceCorruptedReviewKeys(
  value: unknown,
): ReviewKeyRepairResult {
  if (!isPlainObject(value)) {
    return {
      kind: "success",
      notes: [],
      value,
    };
  }

  const topLevelRepair = repairKnownObjectKeys(
    value,
    TOP_LEVEL_REVIEW_KEYS,
    "/",
  );

  if (topLevelRepair.kind === "ambiguous") {
    return topLevelRepair;
  }

  let repairedReview = topLevelRepair.value;
  let changed = topLevelRepair.changed;

  if (Array.isArray(repairedReview.findings)) {
    const repairedFindings: unknown[] = [];
    let changedFindings = false;

    for (let index = 0; index < repairedReview.findings.length; index += 1) {
      const finding = repairedReview.findings[index];

      if (!isPlainObject(finding)) {
        repairedFindings.push(finding);
        continue;
      }

      const findingRepair = repairKnownObjectKeys(
        finding,
        FINDING_REVIEW_KEYS,
        `/findings/${String(index)}`,
      );

      if (findingRepair.kind === "ambiguous") {
        return findingRepair;
      }

      changedFindings = changedFindings || findingRepair.changed;
      repairedFindings.push(findingRepair.value);
    }

    if (changedFindings) {
      repairedReview = {
        ...repairedReview,
        findings: repairedFindings,
      };
      changed = true;
    }
  }

  return {
    kind: "success",
    notes: changed ? [KEY_REPAIR_NORMALIZATION_NOTE] : [],
    value: changed ? repairedReview : value,
  };
}

function repairKnownObjectKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  path: string,
):
  | {
      changed: boolean;
      kind: "success";
      value: Record<string, unknown>;
    }
  | {
      kind: "ambiguous";
      message: string;
    } {
  const repairedEntries: Array<[string, unknown]> = [];
  const originalKeysByRepairedKey = new Map<string, string>();
  let changed = false;

  for (const [key, childValue] of Object.entries(value)) {
    const repairedKey = repairKnownReviewKey(key, allowedKeys);
    const existingOriginalKey = originalKeysByRepairedKey.get(repairedKey);

    if (existingOriginalKey !== undefined) {
      return {
        kind: "ambiguous",
        message: [
          `Cannot normalize whitespace around AI review JSON property names at ${path}:`,
          `${JSON.stringify(existingOriginalKey)} and ${JSON.stringify(key)}`,
          `both resolve to ${JSON.stringify(repairedKey)}.`,
        ].join(" "),
      };
    }

    if (repairedKey !== key) {
      changed = true;
    }

    originalKeysByRepairedKey.set(repairedKey, key);
    repairedEntries.push([repairedKey, childValue]);
  }

  return {
    changed,
    kind: "success",
    value: changed ? Object.fromEntries(repairedEntries) : value,
  };
}

function repairKnownReviewKey(
  key: string,
  allowedKeys: ReadonlySet<string>,
): string {
  const trimmedKey = trimAsciiWhitespaceAndControlCharacters(key);

  return trimmedKey !== key && allowedKeys.has(trimmedKey) ? trimmedKey : key;
}

function trimAsciiWhitespaceAndControlCharacters(value: string): string {
  let start = 0;
  let end = value.length;

  while (
    start < end &&
    isAsciiWhitespaceOrControlCharacter(value.charCodeAt(start))
  ) {
    start += 1;
  }

  while (
    end > start &&
    isAsciiWhitespaceOrControlCharacter(value.charCodeAt(end - 1))
  ) {
    end -= 1;
  }

  return value.slice(start, end);
}

function isAsciiWhitespaceOrControlCharacter(charCode: number): boolean {
  return charCode <= 0x20 || charCode === 0x7f;
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
  errors: readonly AiReviewContractValidationIssue[],
): string {
  if (errors.length === 0) {
    return "The JSON object did not match the Pushgate review schema.";
  }

  return errors.map(formatSchemaError).join(" ");
}

function formatSchemaError(error: AiReviewContractValidationIssue): string {
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

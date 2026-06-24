import {
  AI_REVIEW_FINDING_KEYS,
  AI_REVIEW_TOP_LEVEL_KEYS,
  type AiReviewContractValidationIssue,
  validateAiReviewOutputContract,
} from "../review-contract.js";
import type { RawAiReviewOutput } from "../types.js";

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

export type RepairedReviewValidation =
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

const FINDING_REVIEW_KEYS = new Set<string>(AI_REVIEW_FINDING_KEYS);
const KEY_REPAIR_NORMALIZATION_NOTE =
  "Normalized whitespace around AI review JSON property names.";
const TOP_LEVEL_REVIEW_KEYS = new Set<string>(AI_REVIEW_TOP_LEVEL_KEYS);

export function validateRepairingReview(
  parsed: unknown,
): RepairedReviewValidation {
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

export function unwrapSingleNestedObject(
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

export function formatSchemaDiagnostics(
  errors: readonly AiReviewContractValidationIssue[],
): string {
  if (errors.length === 0) {
    return "The JSON object did not match the Pushgate review schema.";
  }

  return errors.map(formatSchemaError).join(" ");
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatSchemaError(error: AiReviewContractValidationIssue): string {
  const path = error.instancePath || "/";

  switch (error.keyword) {
    case "additionalProperties": {
      const property = String(error.params.additionalProperty);
      return `${path} includes unsupported property ${JSON.stringify(property)}.`;
    }
    case "categorySeverity":
      return (
        error.message ??
        `${path} uses a severity that does not match its category.`
      );
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

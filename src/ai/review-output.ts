import {
  buildCandidates,
  type ParsedCandidate,
} from "./review-output/candidates.js";
import { repairJsonCandidate } from "./review-output/json-repair.js";
import {
  normalizeFinding,
  summarizeFindings,
} from "./review-output/normalization.js";
import {
  formatSchemaDiagnostics,
  unwrapSingleNestedObject,
  validateRepairingReview,
} from "./review-output/validation.js";
import {
  type AiFinding,
  type AiFindingSource,
  type AiReviewSummary,
  type RawAiReviewOutput,
} from "./types.js";

export interface NormalizedAiReviewOutput {
  findings: AiFinding[];
  normalizationNotes: string[];
  summary: AiReviewSummary;
}

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

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dedupeDiagnostics(diagnostics: readonly string[]): string[] {
  return [...new Set(diagnostics)];
}

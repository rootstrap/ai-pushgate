import { z } from "zod";

export const AI_REVIEW_OUTPUT_SCHEMA_ID =
  "https://rootstrap.github.io/ai-pushgate/schemas/ai-review-output-v1.schema.json";
export const AI_REVIEW_OUTPUT_SCHEMA_TITLE = "Pushgate AI Review Output v1";
export const AI_REVIEW_OUTPUT_SCHEMA_VERSION = 1 as const;

export const AI_BLOCKING_CATEGORIES = [
  "security",
  "logic_errors",
] as const;

export const AI_WARNING_CATEGORIES = [
  "test_coverage",
  "performance",
  "naming_and_readability",
] as const;

export const AI_FINDING_CATEGORIES = [
  ...AI_BLOCKING_CATEGORIES,
  ...AI_WARNING_CATEGORIES,
] as const;

export const AI_FINDING_CONFIDENCE_LEVELS = [
  "low",
  "medium",
  "high",
] as const;

export const AI_FINDING_SEVERITIES = [
  "blocking",
  "warning",
] as const;

const nonEmptyStringSchema = z.string().min(1);

const aiReviewFindingShape = {
  category: z.enum(AI_FINDING_CATEGORIES),
  confidence: z.enum(AI_FINDING_CONFIDENCE_LEVELS),
  severity: z.enum(AI_FINDING_SEVERITIES),
  file: nonEmptyStringSchema,
  line: nonEmptyStringSchema,
  message: nonEmptyStringSchema,
  suggestion: nonEmptyStringSchema,
} as const;

export const AiReviewFindingSchema = z
  .object(aiReviewFindingShape)
  .strict();

const aiReviewOutputShape = {
  schema_version: z.literal(AI_REVIEW_OUTPUT_SCHEMA_VERSION),
  findings: z.array(AiReviewFindingSchema),
} as const;

export const AiReviewOutputSchema = z.object(aiReviewOutputShape).strict();

export const AI_REVIEW_FINDING_KEYS = typedKeys(aiReviewFindingShape);
export const AI_REVIEW_TOP_LEVEL_KEYS = typedKeys(aiReviewOutputShape);

export type AiFindingSeverity = z.infer<
  typeof AiReviewFindingSchema
>["severity"];
export type AiFindingCategory = z.infer<
  typeof AiReviewFindingSchema
>["category"];
export type AiFindingConfidence = z.infer<
  typeof AiReviewFindingSchema
>["confidence"];
export type RawAiFinding = z.infer<typeof AiReviewFindingSchema>;
export type RawAiReviewOutput = z.infer<typeof AiReviewOutputSchema>;

type AiReviewZodIssue = Extract<
  ReturnType<typeof AiReviewOutputSchema.safeParse>,
  { success: false }
>["error"]["issues"][number];

export interface AiReviewContractValidationIssue {
  readonly instancePath: string;
  readonly keyword:
    | "additionalProperties"
    | "const"
    | "enum"
    | "minLength"
    | "required"
    | "type";
  readonly message?: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export type AiReviewContractValidationResult =
  | {
      readonly data: RawAiReviewOutput;
      readonly valid: true;
    }
  | {
      readonly errors: readonly AiReviewContractValidationIssue[];
      readonly valid: false;
    };

export function validateAiReviewOutputContract(
  value: unknown,
): AiReviewContractValidationResult {
  const parsed = AiReviewOutputSchema.safeParse(value);

  if (parsed.success) {
    return {
      data: parsed.data,
      valid: true,
    };
  }

  return {
    errors: parsed.error.issues.flatMap((issue) =>
      mapZodIssueToContractIssues(value, issue),
    ),
    valid: false,
  };
}

export function generateAiReviewOutputJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(AiReviewOutputSchema, {
    override({ jsonSchema, path }) {
      if (pathMatches(path, ["properties", "schema_version"])) {
        jsonSchema.type = "integer";
      }
    },
    target: "draft-07",
  }) as Record<string, unknown>;
  const properties = schema.properties as Record<string, unknown>;

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: AI_REVIEW_OUTPUT_SCHEMA_ID,
    title: AI_REVIEW_OUTPUT_SCHEMA_TITLE,
    type: "object",
    additionalProperties: false,
    required: schema.required,
    properties,
  };
}

function mapZodIssueToContractIssues(
  value: unknown,
  issue: AiReviewZodIssue,
): AiReviewContractValidationIssue[] {
  const path = issue.path ?? [];
  const missingProperty = findMissingProperty(value, path);

  if (missingProperty !== null) {
    return [
      {
        instancePath: pathToJsonPointer(path.slice(0, -1)),
        keyword: "required",
        params: {
          missingProperty,
        },
      },
    ];
  }

  switch (issue.code) {
    case "invalid_type":
      return [
        {
          instancePath: pathToJsonPointer(path),
          keyword: "type",
          message: issue.message,
          params: {
            type: String(issue.expected),
          },
        },
      ];
    case "invalid_value":
      return [
        {
          instancePath: pathToJsonPointer(path),
          keyword: pathMatches(path, ["schema_version"]) ? "const" : "enum",
          message: issue.message,
          params: {
            allowedValues: issue.values,
          },
        },
      ];
    case "too_small":
      return [
        {
          instancePath: pathToJsonPointer(path),
          keyword: "minLength",
          message: issue.message,
          params: {
            limit: issue.minimum,
          },
        },
      ];
    case "unrecognized_keys":
      return issue.keys.map((key) => ({
        instancePath: pathToJsonPointer(path),
        keyword: "additionalProperties",
        message: issue.message,
        params: {
          additionalProperty: key,
        },
      }));
    default:
      return [
        {
          instancePath: pathToJsonPointer(path),
          keyword: "type",
          message: issue.message,
          params: {
            type: "valid Pushgate AI review output",
          },
        },
      ];
  }
}

function findMissingProperty(
  value: unknown,
  path: readonly (PropertyKey | number)[],
): string | null {
  const key = path.at(-1);

  if (typeof key !== "string") {
    return null;
  }

  const parent = getValueAtPath(value, path.slice(0, -1));

  if (!isObjectLike(parent)) {
    return null;
  }

  return Object.prototype.hasOwnProperty.call(parent, key) ? null : key;
}

function getValueAtPath(
  value: unknown,
  path: readonly (PropertyKey | number)[],
): unknown {
  let current = value;

  for (const key of path) {
    if (!isObjectLike(current)) {
      return undefined;
    }

    current = current[key as keyof typeof current];
  }

  return current;
}

function isObjectLike(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function pathToJsonPointer(path: readonly (PropertyKey | number)[]): string {
  if (path.length === 0) {
    return "";
  }

  return `/${path.map(escapeJsonPointerSegment).join("/")}`;
}

function escapeJsonPointerSegment(segment: PropertyKey | number): string {
  return String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
}

function pathMatches(
  actual: readonly (PropertyKey | number)[],
  expected: readonly (PropertyKey | number)[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((segment, index) => segment === expected[index])
  );
}

function typedKeys<T extends Record<string, unknown>>(
  value: T,
): readonly Extract<keyof T, string>[] {
  return Object.freeze(Object.keys(value) as Extract<keyof T, string>[]);
}

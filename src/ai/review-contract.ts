import { z } from "zod";

export const AI_REVIEW_OUTPUT_SCHEMA_ID =
  "https://rootstrap.github.io/ai-pushgate/schemas/ai-review-output-v1.schema.json";
export const AI_REVIEW_OUTPUT_SCHEMA_TITLE = "Pushgate AI Review Output v1";
export const AI_REVIEW_OUTPUT_SCHEMA_VERSION = 1 as const;

export const AI_FINDING_SEVERITIES = [
  "blocking",
  "warning",
] as const;

const AI_BLOCKING_FINDING_SEVERITY = AI_FINDING_SEVERITIES[0];
const AI_WARNING_FINDING_SEVERITY = AI_FINDING_SEVERITIES[1];

export const AI_REVIEW_CATEGORY_GROUPS = {
  [AI_BLOCKING_FINDING_SEVERITY]: [
    "security",
    "logic_errors",
  ],
  [AI_WARNING_FINDING_SEVERITY]: [
    "test_coverage",
    "performance",
    "naming_and_readability",
  ],
} as const satisfies Record<
  (typeof AI_FINDING_SEVERITIES)[number],
  readonly string[]
>;

export const AI_BLOCKING_CATEGORIES = AI_REVIEW_CATEGORY_GROUPS.blocking;
export const AI_WARNING_CATEGORIES = AI_REVIEW_CATEGORY_GROUPS.warning;

export const AI_FINDING_CATEGORIES = [
  ...AI_BLOCKING_CATEGORIES,
  ...AI_WARNING_CATEGORIES,
] as const;

export const AI_FINDING_CONFIDENCE_LEVELS = [
  "low",
  "medium",
  "high",
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

export type AiReviewFindingKey = Extract<
  keyof typeof aiReviewFindingShape,
  string
>;
export type AiReviewTopLevelKey = Extract<
  keyof typeof aiReviewOutputShape,
  string
>;

export const AI_REVIEW_FINDING_KEYS: readonly AiReviewFindingKey[] =
  typedKeys(aiReviewFindingShape);
export const AI_REVIEW_TOP_LEVEL_KEYS: readonly AiReviewTopLevelKey[] =
  typedKeys(aiReviewOutputShape);

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

export interface AiReviewFindingFieldPromptDoc {
  readonly description: string;
  readonly key: AiReviewFindingKey;
}

const aiReviewFindingFieldPromptDescriptions = {
  category: "one exact category string from the list above",
  confidence: `${formatInlineEnum(AI_FINDING_CONFIDENCE_LEVELS)}`,
  severity: [
    `${formatInlineCode(AI_BLOCKING_FINDING_SEVERITY)} for`,
    `${AI_BLOCKING_FINDING_SEVERITY} categories,`,
    `${formatInlineCode(AI_WARNING_FINDING_SEVERITY)} for`,
    `${AI_WARNING_FINDING_SEVERITY} categories`,
  ].join(" "),
  file: "repo-relative path",
  line: `line number, line range, or ${formatInlineCode("N/A")}`,
  message: "clear description of the issue",
  suggestion: "concrete actionable fix",
} as const satisfies Record<AiReviewFindingKey, string>;

export const AI_REVIEW_FINDING_FIELD_PROMPT_DOCS: readonly AiReviewFindingFieldPromptDoc[] =
  Object.freeze(
    AI_REVIEW_FINDING_KEYS.map((key) => ({
      description: aiReviewFindingFieldPromptDescriptions[key],
      key,
    })),
  );

const AI_REVIEW_CATEGORY_SEVERITY_BY_CATEGORY = new Map<
  AiFindingCategory,
  AiFindingSeverity
>([
  ...AI_BLOCKING_CATEGORIES.map(
    (category) => [category, AI_BLOCKING_FINDING_SEVERITY] as const,
  ),
  ...AI_WARNING_CATEGORIES.map(
    (category) => [category, AI_WARNING_FINDING_SEVERITY] as const,
  ),
]);

export const AI_REVIEW_OUTPUT_EXAMPLE = {
  schema_version: AI_REVIEW_OUTPUT_SCHEMA_VERSION,
  findings: [
    {
      category: "logic_errors",
      confidence: "high",
      severity: getAiReviewFindingCategorySeverity("logic_errors"),
      file: "src/example.ts",
      line: "12-14",
      message: "Explain the issue clearly.",
      suggestion: "Describe the concrete fix.",
    },
  ],
} satisfies RawAiReviewOutput;

type AiReviewZodIssue = Extract<
  ReturnType<typeof AiReviewOutputSchema.safeParse>,
  { success: false }
>["error"]["issues"][number];

export interface AiReviewContractValidationIssue {
  readonly instancePath: string;
  readonly keyword:
    | "additionalProperties"
    | "categorySeverity"
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
    const semanticIssues = validateAiReviewFindingSemantics(
      parsed.data.findings,
    );

    if (semanticIssues.length > 0) {
      return {
        errors: semanticIssues,
        valid: false,
      };
    }

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

export function getAiReviewFindingCategorySeverity(
  category: AiFindingCategory,
): AiFindingSeverity {
  const severity = AI_REVIEW_CATEGORY_SEVERITY_BY_CATEGORY.get(category);

  if (severity === undefined) {
    throw new Error(`Unknown AI review finding category: ${category}`);
  }

  return severity;
}

export function validateAiReviewFindingSemantics(
  findings: readonly RawAiFinding[],
): AiReviewContractValidationIssue[] {
  const issues: AiReviewContractValidationIssue[] = [];

  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index];

    if (finding === undefined) {
      continue;
    }

    const expectedSeverity = getAiReviewFindingCategorySeverity(
      finding.category,
    );

    if (finding.severity === expectedSeverity) {
      continue;
    }

    issues.push({
      instancePath: `/findings/${String(index)}/severity`,
      keyword: "categorySeverity",
      message: [
        `Finding ${JSON.stringify(finding.category)} must use severity`,
        `${JSON.stringify(expectedSeverity)}.`,
      ].join(" "),
      params: {
        actualSeverity: finding.severity,
        category: finding.category,
        expectedSeverity,
      },
    });
  }

  return issues;
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

function formatInlineCode(value: string): string {
  return `\`${value}\``;
}

function formatInlineEnum(values: readonly string[]): string {
  const formattedValues = values.map(formatInlineCode);

  if (formattedValues.length <= 2) {
    return formattedValues.join(" or ");
  }

  return [
    formattedValues.slice(0, -1).join(", "),
    formattedValues.at(-1),
  ].join(", or ");
}

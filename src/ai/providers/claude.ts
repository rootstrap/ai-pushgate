import { runCommand } from "../../process/run-command.js";
import { generateAiReviewOutputJsonSchema } from "../review-contract.js";
import type { LocalAiProviderAdapter } from "../types.js";
import { selectProviderModel } from "./config.js";
import { normalizeProviderReviewObject } from "./normalize-review.js";
import { runProviderCommand } from "./run-provider-command.js";

export const claudeProvider: LocalAiProviderAdapter = {
  id: "claude",
  structuredOutputCapability: "native_json_schema",
  async runReview(options) {
    const model = selectProviderModel(options.providerConfig);
    const args = buildClaudeArgs(options.repoRoot, model);
    const commandResult = await runProviderCommand({
      args,
      command: "claude",
      cwd: options.repoRoot,
      env: options.env,
      prompt: options.payload.prompt,
      timeoutSeconds: options.timeoutSeconds,
    });

    if (commandResult.kind === "spawn-error") {
      return {
        kind: "provider-error",
        code: "missing_binary",
        provider: "claude",
        message:
          "Claude Code CLI was not found on PATH. Install it before running Pushgate local AI review.",
      };
    }

    if (commandResult.kind === "timeout") {
      return {
        kind: "provider-error",
        code: "timed_out",
        provider: "claude",
        message: `Claude Code CLI timed out after ${String(options.timeoutSeconds)}s.`,
        output: commandResult.output,
      };
    }

    if (commandResult.code !== 0) {
      const output = commandResult.output ?? "";

      if (isClaudeStructuredOutputUnsupported(output)) {
        return {
          kind: "provider-error",
          code: "unsupported_structured_output",
          provider: "claude",
          message:
            "Claude Code CLI does not appear to support native structured output. Upgrade Claude Code to a version that supports `claude -p --json-schema`.",
          output: commandResult.output,
        };
      }

      if (await isClaudeUnauthenticated(options.repoRoot, options.env)) {
        return {
          kind: "provider-error",
          code: "not_authenticated",
          provider: "claude",
          message:
            "Claude Code CLI is not authenticated. Run `claude auth login` before pushing again.",
          output: commandResult.output,
        };
      }

      return {
        kind: "provider-error",
        code: "command_failed",
        provider: "claude",
        message: `Claude Code CLI exited with code ${String(commandResult.code)}.`,
        output: commandResult.output,
      };
    }

    const extractedOutput = extractClaudeStructuredReviewObject(
      commandResult.stdout,
    );

    if (extractedOutput.kind === "empty") {
      return {
        kind: "provider-error",
        code: "empty_output",
        provider: "claude",
        message: "Claude Code CLI returned an empty structured review response.",
        output: commandResult.output,
      };
    }

    if (extractedOutput.kind === "malformed-json") {
      return {
        kind: "provider-error",
        code: "malformed_transport",
        provider: "claude",
        message:
          "Claude Code CLI returned malformed structured review output.",
        detail: extractedOutput.detail,
        output: commandResult.output,
      };
    }

    if (extractedOutput.kind === "structured-output-error") {
      return {
        kind: "provider-error",
        code: "invalid_output",
        provider: "claude",
        message:
          "Claude Code CLI could not produce structured review output matching the Pushgate schema.",
        detail: extractedOutput.detail,
        output: commandResult.output,
      };
    }

    return normalizeProviderReviewObject({
      invalidOutputMessage: "Claude Code CLI returned malformed review output.",
      model,
      output: commandResult.output,
      provider: "claude",
      rawOutput: commandResult.stdout,
      value: extractedOutput.value,
    });
  },
};

function buildClaudeArgs(repoRoot: string, model?: string): string[] {
  const reviewSchema = JSON.stringify(generateAiReviewOutputJsonSchema());
  const args = [
    "-p",
    "Review the provided Pushgate review input exactly as instructed.",
    "--output-format",
    "json",
    "--json-schema",
    reviewSchema,
    "--bare",
    "--tools",
    "Read",
    "--allowedTools",
    "Read",
    "--permission-mode",
    "bypassPermissions",
    "--no-session-persistence",
    "--add-dir",
    repoRoot,
  ];

  if (model) {
    args.push("--model", model);
  }

  return args;
}

type JsonObject = Record<string, unknown>;
type ClaudeStructuredReviewExtraction =
  | {
      kind: "success";
      value: unknown;
    }
  | {
      kind: "empty";
    }
  | {
      detail: string;
      kind: "malformed-json";
    }
  | {
      detail: string;
      kind: "structured-output-error";
    };

const CLAUDE_STRUCTURED_OUTPUT_TYPE = "result";
const CLAUDE_STRUCTURED_OUTPUT_SUCCESS_SUBTYPE = "success";

function extractClaudeStructuredReviewObject(
  stdout: string,
): ClaudeStructuredReviewExtraction {
  const rawOutput = stdout.replace(/\r/g, "").trim();

  if (rawOutput.length === 0) {
    return { kind: "empty" };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawOutput);
  } catch (error) {
    return {
      detail: `Claude structured output failed to parse JSON (${formatUnknownError(error)}).`,
      kind: "malformed-json",
    };
  }

  return extractClaudeStructuredReviewEnvelope(parsed);
}

function extractClaudeStructuredReviewEnvelope(
  envelope: unknown,
): Exclude<ClaudeStructuredReviewExtraction, { kind: "empty" }> {
  if (!isJsonObject(envelope)) {
    return {
      detail: `Claude structured output was ${typeof envelope}, not a JSON object.`,
      kind: "malformed-json",
    };
  }

  const type = envelope.type;

  if (type !== CLAUDE_STRUCTURED_OUTPUT_TYPE) {
    return {
      detail: `Claude structured output JSON expected top-level type ${JSON.stringify(CLAUDE_STRUCTURED_OUTPUT_TYPE)}, but received ${formatJsonTypeValue(type)}.`,
      kind: "malformed-json",
    };
  }

  const subtype = envelope.subtype;

  if (typeof subtype !== "string" || subtype.length === 0) {
    return {
      detail:
        "Claude structured output JSON did not include a top-level `subtype` string.",
      kind: "malformed-json",
    };
  }

  if (subtype !== CLAUDE_STRUCTURED_OUTPUT_SUCCESS_SUBTYPE) {
    return {
      detail: formatClaudeStructuredOutputFailure(envelope, subtype),
      kind: "structured-output-error",
    };
  }

  if (!Object.prototype.hasOwnProperty.call(envelope, "structured_output")) {
    return {
      detail:
        "Claude structured output JSON did not include a top-level `structured_output` field.",
      kind: "malformed-json",
    };
  }

  const value = envelope.structured_output;

  if (!isJsonObject(value)) {
    return {
      detail:
        "Claude structured output `structured_output` field was not a JSON object.",
      kind: "malformed-json",
    };
  }

  return {
    kind: "success",
    value,
  };
}

function formatClaudeStructuredOutputFailure(
  output: JsonObject,
  subtype: string,
): string {
  const errors = Array.isArray(output.errors)
    ? output.errors.map((error) => JSON.stringify(error)).join("\n")
    : "";

  return [
    `Claude structured output result subtype was ${JSON.stringify(subtype)}.`,
    errors.length > 0 ? errors : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function formatJsonTypeValue(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  return `${JSON.stringify(value)} (${Array.isArray(value) ? "array" : typeof value})`;
}

function isClaudeStructuredOutputUnsupported(output: string): boolean {
  return [
    /unknown (?:option|argument).*--json-schema/i,
    /unrecognized (?:option|argument).*--json-schema/i,
    /invalid (?:option|argument).*--json-schema/i,
    /--json-schema.*(?:unknown|unrecognized|invalid)/i,
    /structured output.*not supported/i,
    /json schema.*not supported/i,
  ].some((pattern) => pattern.test(output));
}

async function isClaudeUnauthenticated(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    const result = await runCommand({
      args: ["auth", "status"],
      command: "claude",
      cwd: repoRoot,
      env,
    });

    return result.code === 1;
  } catch {
    return false;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { runCommand } from "../../process/run-command.js";
import { generateAiReviewOutputJsonSchema } from "../review-contract.js";
import { createCommandProviderAdapter } from "./command-provider-adapter.js";
import { selectProviderBoolean, selectProviderModel } from "./config.js";

interface ClaudeInvocationContext {
  bare: boolean;
}

export const claudeProvider =
  createCommandProviderAdapter<ClaudeInvocationContext>({
    id: "claude",
    structuredOutputCapability: "native_json_schema",
    command: "claude",
    buildInvocation(options) {
      const model = selectProviderModel(options.providerConfig);
      const bare = selectProviderBoolean(options.providerConfig, "bare");

      return {
        args: buildClaudeArgs(options.repoRoot, model, bare),
        context: {
          bare,
        },
        model,
      };
    },
    missingBinaryMessage:
      "Claude Code CLI was not found on PATH. Install it before running Pushgate local AI review.",
    formatTimeoutMessage(timeoutSeconds) {
      return `Claude Code CLI timed out after ${String(timeoutSeconds)}s.`;
    },
    formatCommandFailedMessage(code) {
      return `Claude Code CLI exited with code ${String(code)}.`;
    },
    emptyOutputMessage:
      "Claude Code CLI returned an empty structured review response.",
    invalidOutputMessage: "Claude Code CLI returned malformed review output.",
    async mapCommandFailure(commandResult, invocation, options) {
      const output = commandResult.output ?? "";

      if (isClaudeStructuredOutputUnsupported(output)) {
        return {
          kind: "provider-error",
          code: "unsupported_structured_output",
          provider: "claude",
          message:
            "Claude Code CLI does not appear to support native structured output. Upgrade Claude Code to a version that supports `claude -p --json-schema`.",
        };
      }

      if (
        isClaudeAuthFailure(output) ||
        (await isClaudeUnauthenticated(options.repoRoot, options.env))
      ) {
        return {
          kind: "provider-error",
          code: "not_authenticated",
          provider: "claude",
          message: formatClaudeAuthFailureMessage(
            invocation.context?.bare ?? false,
          ),
        };
      }

      return null;
    },
    mapSuccessfulCommandOutput(commandResult, invocation) {
      if (!isClaudeAuthFailure(commandResult.output ?? commandResult.stdout)) {
        return null;
      }

      return {
        kind: "provider-error",
        code: "not_authenticated",
        provider: "claude",
        message: formatClaudeAuthFailureMessage(
          invocation.context?.bare ?? false,
        ),
      };
    },
    extractReview(commandResult) {
      const extractedReview = extractClaudeStructuredReviewObject(
        commandResult.stdout,
      );

      if (extractedReview.kind === "empty") {
        return { kind: "empty" };
      }

      if (extractedReview.kind === "malformed-json") {
        return {
          kind: "provider-error",
          code: "malformed_transport",
          detail: extractedReview.detail,
          message:
            "Claude Code CLI returned malformed structured review output.",
        };
      }

      if (extractedReview.kind === "structured-output-error") {
        return {
          kind: "provider-error",
          code: "invalid_output",
          detail: extractedReview.detail,
          message:
            "Claude Code CLI could not produce structured review output matching the Pushgate schema.",
        };
      }

      return {
        kind: "object",
        rawOutput: commandResult.stdout,
        value: extractedReview.value,
      };
    },
  });

function buildClaudeArgs(
  repoRoot: string,
  model: string | undefined,
  bare: boolean,
): string[] {
  const reviewSchema = JSON.stringify(generateAiReviewOutputJsonSchema());
  const args = [
    "-p",
    "Review the provided Pushgate review input exactly as instructed.",
    "--output-format",
    "json",
    "--json-schema",
    reviewSchema,
    bare ? "--bare" : "--safe-mode",
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

function isClaudeAuthFailure(output: string): boolean {
  return [
    /not authenticated/i,
    /authentication required/i,
    /must authenticate/i,
    /please authenticate/i,
    /not logged in/i,
    /\/login/i,
    /claude auth login/i,
    /api key.*required/i,
  ].some((pattern) => pattern.test(output));
}

function formatClaudeAuthFailureMessage(bare: boolean): string {
  if (bare) {
    return "Claude Code CLI is not authenticated in bare mode. Set `ANTHROPIC_API_KEY` or configure an `apiKeyHelper` through Claude settings, or remove `ai.providers.claude.bare: true` to use local Claude login.";
  }

  return "Claude Code CLI is not authenticated. Run `claude` and complete `/login` in the same user environment that runs `git push` before pushing again.";
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

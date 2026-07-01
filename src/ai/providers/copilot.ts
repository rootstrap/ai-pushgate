import { createCommandProviderAdapter } from "./command-provider-adapter.js";
import { selectProviderModel } from "./config.js";
import {
  createJsonLineStreamObserver,
  emitHumanResponseText,
  isJsonObject,
} from "./streaming.js";

type JsonObject = Record<string, unknown>;

export const copilotProvider = createCommandProviderAdapter({
  id: "copilot",
  displayName: "GitHub Copilot",
  streamingCapability: "human_response_and_final_result",
  structuredOutputCapability: "jsonl_transport",
  command: "copilot",
  buildInvocation(options) {
    const model = selectProviderModel(options.providerConfig);

    return {
      args: buildCopilotArgs({
        model,
        streamResponse: options.streaming?.responseText === true,
      }),
      model,
    };
  },
  createStreamObserver(_invocation, options) {
    if (!options.streaming?.responseText) {
      return undefined;
    }

    return {
      onStdoutChunk: createJsonLineStreamObserver({
        onJsonLine(event) {
          emitHumanResponseText(
            options.streaming,
            readAssistantMessageContent(event),
          );
        },
      }),
    };
  },
  missingBinaryMessage:
    "GitHub Copilot CLI was not found on PATH. Install the standalone `copilot` command before running Pushgate local AI review.",
  formatTimeoutMessage(timeoutSeconds) {
    return `GitHub Copilot CLI timed out after ${String(timeoutSeconds)}s.`;
  },
  formatCommandFailedMessage(code) {
    return `GitHub Copilot CLI exited with code ${String(code)}.`;
  },
  emptyOutputMessage: "GitHub Copilot CLI returned empty JSONL output.",
  invalidOutputMessage:
    "GitHub Copilot CLI returned malformed review output.",
  mapCommandFailure(commandResult) {
    const output = commandResult.output ?? "";

    if (!isCopilotAuthFailure(output)) {
      return null;
    }

    return {
      kind: "provider-error",
      code: "not_authenticated",
      provider: "copilot",
      message:
        "GitHub Copilot CLI is not authenticated or cannot access Copilot. Run `copilot login`, configure `COPILOT_GITHUB_TOKEN`, or verify your Copilot CLI organization policy.",
    };
  },
  extractReview(commandResult) {
    const extractedResponse = extractCopilotFinalAssistantResponse(
      commandResult.stdout,
    );

    if (extractedResponse.kind === "empty") {
      return { kind: "empty" };
    }

    if (extractedResponse.kind === "malformed-jsonl") {
      return {
        kind: "provider-error",
        code: "malformed_transport",
        detail: extractedResponse.detail,
        message:
          "GitHub Copilot CLI returned malformed JSONL transport output.",
      };
    }

    if (extractedResponse.kind === "missing-assistant-response") {
      return {
        kind: "provider-error",
        code: "missing_response",
        detail: extractedResponse.detail,
        message:
          "GitHub Copilot CLI JSONL output did not include a final assistant response.",
      };
    }

    return {
      content: extractedResponse.content,
      kind: "text",
    };
  },
});

function buildCopilotArgs(options: {
  model?: string;
  streamResponse: boolean;
}): string[] {
  const args = [
    "-s",
    "--no-ask-user",
    `--stream=${options.streamResponse ? "on" : "off"}`,
    "--output-format=json",
    "--no-color",
    "--no-custom-instructions",
    "--no-remote",
    "--disable-builtin-mcps",
    "--available-tools=view,grep,glob",
    "--allow-tool=read",
    "--deny-tool=shell",
    "--deny-tool=write",
    "--deny-tool=url",
  ];

  if (options.model) {
    args.push(`--model=${options.model}`);
  }

  return args;
}

function isCopilotAuthFailure(output: string): boolean {
  return [
    /not authenticated/i,
    /authentication required/i,
    /must authenticate/i,
    /please authenticate/i,
    /not logged in/i,
    /copilot login/i,
    /\/login/i,
    /COPILOT_GITHUB_TOKEN/,
    /\bGH_TOKEN\b/,
    /\bGITHUB_TOKEN\b/,
    /copilot.*subscription/i,
    /copilot.*policy.*enabled/i,
    /access.*copilot/i,
  ].some((pattern) => pattern.test(output));
}

function extractCopilotFinalAssistantResponse(stdout: string):
  | {
      content: string;
      kind: "success";
    }
  | {
      kind: "empty";
    }
  | {
      detail: string;
      kind: "malformed-jsonl";
    }
  | {
      detail: string;
      kind: "missing-assistant-response";
    } {
  const lines = stdout
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return { kind: "empty" };
  }

  const mainAssistantContents: string[] = [];
  const assistantContents: string[] = [];

  for (const [index, line] of lines.entries()) {
    let event: unknown;

    try {
      event = JSON.parse(line);
    } catch (error) {
      return {
        detail: `JSONL line ${String(index + 1)} failed to parse JSON (${formatUnknownError(error)}).`,
        kind: "malformed-jsonl",
      };
    }

    if (!isJsonObject(event)) {
      return {
        detail: `JSONL line ${String(index + 1)} was ${typeof event}, not a JSON object.`,
        kind: "malformed-jsonl",
      };
    }

    const content = readAssistantMessageContent(event);

    if (content === null || content.trim().length === 0) {
      continue;
    }

    assistantContents.push(content);

    if (isMainAssistantMessage(event)) {
      mainAssistantContents.push(content);
    }
  }

  const content =
    mainAssistantContents.at(-1) ?? assistantContents.at(-1) ?? null;

  if (content === null) {
    return {
      detail: `Parsed ${String(lines.length)} JSONL event(s), but none contained assistant response content.`,
      kind: "missing-assistant-response",
    };
  }

  return {
    content,
    kind: "success",
  };
}

function readAssistantMessageContent(event: JsonObject): string | null {
  const type = typeof event.type === "string" ? event.type : undefined;
  const data = isJsonObject(event.data) ? event.data : undefined;

  if (type === "assistant.message") {
    if (data && typeof data.content === "string") {
      return data.content;
    }

    if (typeof event.content === "string") {
      return event.content;
    }
  }

  if (
    (type === undefined || type === "message" || type === "assistant") &&
    typeof event.content === "string" &&
    (event.role === undefined || event.role === "assistant")
  ) {
    return event.content;
  }

  return null;
}

function isMainAssistantMessage(event: JsonObject): boolean {
  const data = isJsonObject(event.data) ? event.data : undefined;

  if (
    data &&
    typeof data.parentToolCallId === "string" &&
    data.parentToolCallId.length > 0
  ) {
    return false;
  }

  return (
    !data ||
    typeof data.phase !== "string" ||
    data.phase.toLowerCase() !== "thinking"
  );
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

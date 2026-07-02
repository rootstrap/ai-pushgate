import type { LocalAiProviderStreamingOptions } from "../types.js";

type JsonObject = Record<string, unknown>;

export interface JsonLineStreamObserver {
  flush(): void;
  onChunk(chunk: string): void;
}

export function createJsonLineStreamObserver(options: {
  onJsonLine(event: JsonObject, lineNumber: number): void;
}): JsonLineStreamObserver {
  let buffer = "";
  let lineNumber = 0;

  return {
    flush() {
      processLine(buffer);
      buffer = "";
    },
    onChunk(chunk) {
      buffer += chunk.replace(/\r/g, "");

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        processLine(line);
      }
    },
  };

  function processLine(line: string): void {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      return;
    }

    lineNumber += 1;

    try {
      const parsed = JSON.parse(trimmed);

      if (isJsonObject(parsed)) {
        options.onJsonLine(parsed, lineNumber);
      }
    } catch {
      // The final captured output path reports malformed transport details.
    }
  }
}

export function emitHumanResponseText(
  streaming: LocalAiProviderStreamingOptions | undefined,
  text: string | null,
): boolean {
  if (
    !streaming?.responseText ||
    !streaming.onEvent ||
    text === null ||
    text.length === 0 ||
    looksLikePushgateReviewContractText(text)
  ) {
    return false;
  }

  streaming.onEvent({
    kind: "response-text-delta",
    text,
  });
  return true;
}

export function looksLikePushgateReviewContractText(text: string): boolean {
  const candidate = unwrapJsonCandidate(text.trim());

  if (candidate === null || !/^[{[]/.test(candidate)) {
    return false;
  }

  try {
    return isReviewContractObject(JSON.parse(candidate));
  } catch {
    return false;
  }
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapJsonCandidate(text: string): string | null {
  const fencedJson = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);

  if (fencedJson) {
    return fencedJson[1]?.trim() ?? null;
  }

  return text;
}

function isReviewContractObject(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    "schema_version" in value &&
    "findings" in value
  );
}

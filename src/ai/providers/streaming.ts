import type { LocalAiProviderStreamingOptions } from "../types.js";

type JsonObject = Record<string, unknown>;

export function createJsonLineStreamObserver(options: {
  onJsonLine(event: JsonObject, lineNumber: number): void;
}): (chunk: string) => void {
  let buffer = "";
  let lineNumber = 0;

  return (chunk: string) => {
    buffer += chunk.replace(/\r/g, "");

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.length === 0) {
        continue;
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
  };
}

export function emitHumanResponseText(
  streaming: LocalAiProviderStreamingOptions | undefined,
  text: string | null,
): void {
  if (
    !streaming?.responseText ||
    !streaming.onEvent ||
    text === null ||
    text.length === 0 ||
    looksLikePushgateReviewContractText(text)
  ) {
    return;
  }

  streaming.onEvent({
    kind: "response-text-delta",
    text,
  });
}

export function looksLikePushgateReviewContractText(text: string): boolean {
  const trimmed = text.trimStart();

  return (
    /^[{[]/.test(trimmed) &&
    /"?schema_version"?|"?findings"?/.test(trimmed)
  );
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

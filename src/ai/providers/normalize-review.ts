import { AiReviewOutputError, parseAiReviewOutput } from "../review-output.js";
import type { LocalAiProviderResult } from "../types.js";

export function normalizeProviderReviewOutput(options: {
  emptyOutputMessage: string;
  invalidOutputMessage: string;
  model?: string;
  output?: string;
  provider: string;
  stdout: string;
}): LocalAiProviderResult {
  const rawOutput = options.stdout.trim();

  if (rawOutput.length === 0) {
    return {
      kind: "provider-error",
      code: "empty_output",
      provider: options.provider,
      message: options.emptyOutputMessage,
      output: options.output,
    };
  }

  try {
    const parsed = parseAiReviewOutput(rawOutput, {
      provider: options.provider,
      ...(options.model ? { model: options.model } : {}),
    });

    return {
      kind: "review",
      provider: options.provider,
      findings: parsed.findings,
      normalizationNotes: parsed.normalizationNotes,
      rawOutput,
      summary: parsed.summary,
    };
  } catch (error) {
    const detail =
      error instanceof AiReviewOutputError
        ? error.diagnostics.join("\n") || error.message
        : String(error);

    return {
      kind: "provider-error",
      code: "invalid_output",
      provider: options.provider,
      message: options.invalidOutputMessage,
      detail,
      output: options.output,
    };
  }
}

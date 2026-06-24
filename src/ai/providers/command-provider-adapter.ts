import {
  normalizeProviderReviewObject,
  normalizeProviderReviewOutput,
} from "./normalize-review.js";
import {
  runProviderCommand,
  type ProviderCommandResult,
} from "./run-provider-command.js";
import type {
  LocalAiProviderAdapter,
  LocalAiProviderFailure,
  LocalAiProviderFailureCode,
  LocalAiProviderResult,
  LocalAiProviderRunOptions,
  LocalAiProviderStructuredOutputCapability,
} from "../types.js";

type CompletedProviderCommandResult = Extract<
  ProviderCommandResult,
  { kind: "completed" }
>;

export interface CommandProviderInvocation<TContext> {
  args: readonly string[];
  context?: TContext;
  model?: string;
}

export type CommandProviderReviewExtraction =
  | {
      content: string;
      kind: "text";
    }
  | {
      kind: "object";
      rawOutput?: string;
      value: unknown;
    }
  | {
      kind: "empty";
    }
  | {
      code: LocalAiProviderFailureCode;
      detail?: string;
      kind: "provider-error";
      message: string;
    };

export interface CommandProviderAdapterSpec<TContext> {
  buildInvocation(
    options: LocalAiProviderRunOptions,
  ): CommandProviderInvocation<TContext>;
  command: string;
  emptyOutputMessage: string;
  extractReview(
    commandResult: CompletedProviderCommandResult,
    invocation: CommandProviderInvocation<TContext>,
    options: LocalAiProviderRunOptions,
  ): CommandProviderReviewExtraction;
  formatCommandFailedMessage(code: number | null): string;
  formatTimeoutMessage(timeoutSeconds: number): string;
  id: string;
  invalidOutputMessage: string;
  mapCommandFailure?(
    commandResult: CompletedProviderCommandResult,
    invocation: CommandProviderInvocation<TContext>,
    options: LocalAiProviderRunOptions,
  ): Promise<LocalAiProviderFailure | null> | LocalAiProviderFailure | null;
  mapSuccessfulCommandOutput?(
    commandResult: CompletedProviderCommandResult,
    invocation: CommandProviderInvocation<TContext>,
    options: LocalAiProviderRunOptions,
  ): Promise<LocalAiProviderFailure | null> | LocalAiProviderFailure | null;
  missingBinaryMessage: string;
  structuredOutputCapability: LocalAiProviderStructuredOutputCapability;
}

export interface CommandProviderAdapterDependencies {
  runCommand?: typeof runProviderCommand;
}

export function createCommandProviderAdapter<TContext = undefined>(
  spec: CommandProviderAdapterSpec<TContext>,
  dependencies: CommandProviderAdapterDependencies = {},
): LocalAiProviderAdapter {
  const runCommand = dependencies.runCommand ?? runProviderCommand;

  return {
    id: spec.id,
    structuredOutputCapability: spec.structuredOutputCapability,
    async runReview(options) {
      const invocation = spec.buildInvocation(options);
      const commandResult = await runCommand({
        args: invocation.args,
        command: spec.command,
        cwd: options.repoRoot,
        env: options.env,
        prompt: options.payload.prompt,
        timeoutSeconds: options.timeoutSeconds,
      });

      if (commandResult.kind === "spawn-error") {
        return providerFailure({
          code: "missing_binary",
          message: spec.missingBinaryMessage,
          provider: spec.id,
        });
      }

      if (commandResult.kind === "timeout") {
        return providerFailure({
          code: "timed_out",
          message: spec.formatTimeoutMessage(options.timeoutSeconds),
          output: commandResult.output,
          provider: spec.id,
        });
      }

      if (commandResult.code !== 0) {
        const mappedFailure = await spec.mapCommandFailure?.(
          commandResult,
          invocation,
          options,
        );

        if (mappedFailure) {
          return withCommandOutput(mappedFailure, commandResult.output);
        }

        return providerFailure({
          code: "command_failed",
          message: spec.formatCommandFailedMessage(commandResult.code),
          output: commandResult.output,
          provider: spec.id,
        });
      }

      const successfulOutputFailure = await spec.mapSuccessfulCommandOutput?.(
        commandResult,
        invocation,
        options,
      );

      if (successfulOutputFailure) {
        return withCommandOutput(successfulOutputFailure, commandResult.output);
      }

      const extractedReview = spec.extractReview(
        commandResult,
        invocation,
        options,
      );

      return normalizeExtractedReview({
        commandResult,
        extraction: extractedReview,
        invalidOutputMessage: spec.invalidOutputMessage,
        emptyOutputMessage: spec.emptyOutputMessage,
        model: invocation.model,
        provider: spec.id,
      });
    },
  };
}

function normalizeExtractedReview(options: {
  commandResult: CompletedProviderCommandResult;
  emptyOutputMessage: string;
  extraction: CommandProviderReviewExtraction;
  invalidOutputMessage: string;
  model?: string;
  provider: string;
}): LocalAiProviderResult {
  switch (options.extraction.kind) {
    case "empty":
      return providerFailure({
        code: "empty_output",
        message: options.emptyOutputMessage,
        output: options.commandResult.output,
        provider: options.provider,
      });
    case "provider-error":
      return providerFailure({
        code: options.extraction.code,
        detail: options.extraction.detail,
        message: options.extraction.message,
        output: options.commandResult.output,
        provider: options.provider,
      });
    case "object":
      return normalizeProviderReviewObject({
        invalidOutputMessage: options.invalidOutputMessage,
        model: options.model,
        output: options.commandResult.output,
        provider: options.provider,
        rawOutput: options.extraction.rawOutput,
        value: options.extraction.value,
      });
    case "text":
      return normalizeProviderReviewOutput({
        emptyOutputMessage: options.emptyOutputMessage,
        invalidOutputMessage: options.invalidOutputMessage,
        model: options.model,
        output: options.commandResult.output,
        provider: options.provider,
        stdout: options.extraction.content,
      });
  }
}

function providerFailure(options: {
  code: LocalAiProviderFailureCode;
  detail?: string;
  message: string;
  output?: string;
  provider: string;
}): LocalAiProviderFailure {
  return {
    kind: "provider-error",
    code: options.code,
    provider: options.provider,
    message: options.message,
    ...(options.detail ? { detail: options.detail } : {}),
    ...(options.output ? { output: options.output } : {}),
  };
}

function withCommandOutput(
  failure: LocalAiProviderFailure,
  output: string | undefined,
): LocalAiProviderFailure {
  if (failure.output !== undefined || output === undefined) {
    return failure;
  }

  return {
    ...failure,
    output,
  };
}

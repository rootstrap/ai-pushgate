import {
  runTimedCommand,
  type RunTimedCommandOptions,
  type TimedCommandResult,
} from "./timed-command.js";

type CompletedTimedCommandResult = Extract<
  TimedCommandResult,
  { kind: "completed" }
>;

export type ProcessFailure =
  | {
      error: Error;
      kind: "spawn-error";
    }
  | {
      kind: "timeout";
      timeoutSeconds: number;
    }
  | {
      code: number;
      kind: "exit-code";
    }
  | {
      kind: "signal";
      signal: NodeJS.Signals | null;
    };

export type ProcessCompletionFailure = Extract<
  ProcessFailure,
  { kind: "exit-code" | "signal" }
>;

export interface ProcessPassedOutcome {
  kind: "passed";
  outputTail?: string;
  stderr: string;
  stdout: string;
}

export interface ProcessStartOrTimeoutFailureOutcome {
  failure: Exclude<ProcessFailure, ProcessCompletionFailure>;
  kind: "failed";
  outputTail?: string;
}

export interface ProcessCompletionFailureOutcome {
  failure: ProcessCompletionFailure;
  kind: "failed";
  outputTail?: string;
  stderr: string;
  stdout: string;
}

export type ProcessOutcome =
  | ProcessPassedOutcome
  | ProcessStartOrTimeoutFailureOutcome
  | ProcessCompletionFailureOutcome;

export type ProcessCompletionOutcome =
  | ProcessPassedOutcome
  | ProcessCompletionFailureOutcome;

export type RunProcessOutcomeOptions = RunTimedCommandOptions;

export async function runProcessOutcome(
  options: RunProcessOutcomeOptions,
): Promise<ProcessOutcome> {
  return classifyProcessOutcome(await runTimedCommand(options), {
    timeoutSeconds: options.timeoutSeconds,
  });
}

export function classifyProcessOutcome(
  result: TimedCommandResult,
  options: {
    timeoutSeconds: number;
  },
): ProcessOutcome {
  if (result.kind === "spawn-error") {
    return {
      failure: {
        error: result.error,
        kind: "spawn-error",
      },
      kind: "failed",
      outputTail: result.outputTail,
    };
  }

  if (result.kind === "timeout") {
    return {
      failure: {
        kind: "timeout",
        timeoutSeconds: options.timeoutSeconds,
      },
      kind: "failed",
      outputTail: result.outputTail,
    };
  }

  const failure = completedCommandFailure(result);

  if (!failure) {
    return {
      kind: "passed",
      outputTail: result.outputTail,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  }

  return {
    failure,
    kind: "failed",
    outputTail: result.outputTail,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

export function formatProcessFailure(
  failure: ProcessFailure,
  options: {
    subject?: string;
  } = {},
): string {
  switch (failure.kind) {
    case "spawn-error":
      return options.subject
        ? `failed to start ${options.subject}: ${failure.error.message}`
        : `failed to start: ${failure.error.message}`;
    case "timeout":
      return options.subject
        ? `${options.subject} timed out after ${String(failure.timeoutSeconds)}s`
        : `timed out after ${String(failure.timeoutSeconds)}s`;
    case "exit-code":
      return options.subject
        ? `${options.subject} exited with code ${String(failure.code)}`
        : `exited with code ${String(failure.code)}`;
    case "signal":
      return options.subject
        ? `${options.subject} ended by signal ${failure.signal ?? "unknown"}`
        : `ended by signal ${failure.signal ?? "unknown"}`;
  }
}

export function isProcessCompletionOutcome(
  outcome: ProcessOutcome,
): outcome is ProcessCompletionOutcome {
  return (
    outcome.kind === "passed" ||
    outcome.failure.kind === "exit-code" ||
    outcome.failure.kind === "signal"
  );
}

function completedCommandFailure(
  result: CompletedTimedCommandResult,
): ProcessCompletionFailure | null {
  if (result.code === 0) {
    return null;
  }

  if (result.code === null) {
    return {
      kind: "signal",
      signal: result.signal,
    };
  }

  return {
    code: result.code,
    kind: "exit-code",
  };
}

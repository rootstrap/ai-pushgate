import { sanitizeGitLocalEnv } from "../../git/environment.js";
import {
  isProcessCompletionOutcome,
  runProcessOutcome,
  type ProcessCompletionFailure,
} from "../../process/outcome-policy.js";

const DEFAULT_OUTPUT_TAIL_LIMIT = 8 * 1024;

export type ProviderCommandResult =
  | {
      code: number | null;
      failure?: ProcessCompletionFailure;
      kind: "completed";
      output?: string;
      signal?: NodeJS.Signals | null;
      stdout: string;
    }
  | {
      kind: "spawn-error";
    }
  | {
      kind: "timeout";
      output?: string;
    };

export async function runProviderCommand(options: {
  args: readonly string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  onStderrChunk?: (chunk: string) => void;
  onStdoutChunk?: (chunk: string) => void;
  outputCaptureLimit?: number;
  outputTailLimit?: number;
  prompt: string;
  timeoutSeconds: number;
}): Promise<ProviderCommandResult> {
  const commandResult = await runProcessOutcome({
    args: options.args,
    command: options.command,
    cwd: options.cwd,
    env: sanitizeGitLocalEnv(options.env),
    onStderrChunk: options.onStderrChunk,
    onStdoutChunk: options.onStdoutChunk,
    outputCaptureLimit: options.outputCaptureLimit ?? null,
    outputTailLimit: options.outputTailLimit ?? DEFAULT_OUTPUT_TAIL_LIMIT,
    // Provider CLIs may exit before stdin fully drains; the process runner still
    // lets the close path report the real provider result.
    stdin: options.prompt,
    timeoutSeconds: options.timeoutSeconds,
  });

  if (!isProcessCompletionOutcome(commandResult)) {
    if (commandResult.failure.kind === "spawn-error") {
      return { kind: "spawn-error" };
    }

    return {
      kind: "timeout",
      output: commandResult.outputTail,
    };
  }

  if (commandResult.kind === "failed") {
    return {
      code:
        commandResult.failure.kind === "exit-code"
          ? commandResult.failure.code
          : null,
      failure: commandResult.failure,
      kind: "completed",
      output: commandResult.outputTail,
      signal:
        commandResult.failure.kind === "signal"
          ? commandResult.failure.signal
          : null,
      stdout: commandResult.stdout,
    };
  }

  return {
    code: 0,
    kind: "completed",
    output: commandResult.outputTail,
    signal: null,
    stdout: commandResult.stdout,
  };
}

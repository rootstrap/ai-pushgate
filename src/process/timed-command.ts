import { runCapturedCommand } from "./captured-command.js";

const DEFAULT_OUTPUT_CAPTURE_LIMIT = 64 * 1024;
const DEFAULT_OUTPUT_TAIL_LIMIT = 4 * 1024;
const DEFAULT_KILL_GRACE_MS = 1_000;

export type TimedCommandResult =
  | {
      code: number | null;
      kind: "completed";
      outputTail?: string;
      signal: NodeJS.Signals | null;
      stderr: string;
      stdout: string;
    }
  | {
      error: Error;
      kind: "spawn-error";
      outputTail?: string;
    }
  | {
      kind: "timeout";
      outputTail?: string;
    };

export interface RunTimedCommandOptions {
  args: readonly string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  killGraceMs?: number;
  outputCaptureLimit?: number | null;
  outputTailLimit?: number;
  stdin?: string;
  timeoutSeconds: number;
}

export async function runTimedCommand(
  options: RunTimedCommandOptions,
): Promise<TimedCommandResult> {
  const commandResult = await runCapturedCommand({
    args: options.args,
    command: options.command,
    cwd: options.cwd,
    env: options.env,
    ignoreStdinErrors: true,
    killGraceMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    outputCaptureLimit:
      options.outputCaptureLimit === null
        ? undefined
        : (options.outputCaptureLimit ?? DEFAULT_OUTPUT_CAPTURE_LIMIT),
    outputEncoding: "utf8",
    outputTailLimit: options.outputTailLimit ?? DEFAULT_OUTPUT_TAIL_LIMIT,
    shell: false,
    stdin: options.stdin,
    timeoutMs: options.timeoutSeconds * 1_000,
  });

  if (commandResult.kind === "spawn-error") {
    return {
      error: commandResult.error,
      kind: "spawn-error",
      outputTail: commandResult.outputTail,
    };
  }

  if (commandResult.kind === "timeout") {
    return {
      kind: "timeout",
      outputTail: commandResult.outputTail,
    };
  }

  return {
    code: commandResult.code,
    kind: "completed",
    outputTail: commandResult.outputTail,
    signal: commandResult.signal,
    stderr: commandResult.stderr,
    stdout: commandResult.stdout,
  };
}

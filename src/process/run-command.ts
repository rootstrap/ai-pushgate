import {
  runCapturedCommand,
  type CapturedCommandResult,
} from "./captured-command.js";

export type CommandOutputEncoding = "buffer" | "utf8";

export interface CommandResult<Stdout extends Buffer | string = string> {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: Stdout;
}

export interface RunCommandOptions {
  args?: readonly string[];
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  outputEncoding?: CommandOutputEncoding;
  stdin?: Buffer | string;
}

export function runCommand(
  options: RunCommandOptions & { outputEncoding: "buffer" },
): Promise<CommandResult<Buffer>>;
export function runCommand(
  options: RunCommandOptions & { outputEncoding?: "utf8" },
): Promise<CommandResult<string>>;
export async function runCommand(
  options: RunCommandOptions,
): Promise<CommandResult<Buffer> | CommandResult<string>> {
  const outputEncoding = options.outputEncoding ?? "utf8";

  if (outputEncoding === "buffer") {
    return completedResult(
      await runCapturedCommand({
        ...options,
        outputEncoding: "buffer",
      }),
    );
  }

  return completedResult(
    await runCapturedCommand({
      ...options,
      outputEncoding: "utf8",
    }),
  );
}

function completedResult<Stdout extends Buffer | string>(
  result: CapturedCommandResult<Stdout>,
): CommandResult<Stdout> {
  if (result.kind === "spawn-error") {
    throw result.error;
  }

  if (result.kind === "timeout") {
    throw new Error("Command timed out unexpectedly.");
  }

  return {
    code: result.code,
    signal: result.signal,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

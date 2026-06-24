import { runTimedCommand } from "../../process/timed-command.js";

const DEFAULT_OUTPUT_TAIL_LIMIT = 8 * 1024;

export type ProviderCommandResult =
  | {
      code: number | null;
      kind: "completed";
      output?: string;
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
  outputCaptureLimit?: number;
  outputTailLimit?: number;
  prompt: string;
  timeoutSeconds: number;
}): Promise<ProviderCommandResult> {
  const commandResult = await runTimedCommand({
    args: options.args,
    command: options.command,
    cwd: options.cwd,
    env: options.env,
    outputCaptureLimit: options.outputCaptureLimit ?? null,
    outputTailLimit: options.outputTailLimit ?? DEFAULT_OUTPUT_TAIL_LIMIT,
    // Provider CLIs may exit before stdin fully drains; runTimedCommand still
    // lets the close path report the real provider result.
    stdin: options.prompt,
    timeoutSeconds: options.timeoutSeconds,
  });

  if (commandResult.kind === "spawn-error") {
    return { kind: "spawn-error" };
  }

  if (commandResult.kind === "timeout") {
    return {
      kind: "timeout",
      output: commandResult.outputTail,
    };
  }

  return {
    code: commandResult.code,
    kind: "completed",
    output: commandResult.outputTail,
    stdout: commandResult.stdout,
  };
}

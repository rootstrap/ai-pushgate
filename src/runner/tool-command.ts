import type { ToolConfig } from "../config/index.js";
import { runTimedCommand } from "../process/timed-command.js";

export const CHANGED_FILES_TOKEN = "{changed_files}" as const;

export interface ToolCommandResult {
  passed: boolean;
  detail?: string;
  outputTail?: string;
}

const OUTPUT_CAPTURE_LIMIT = 64 * 1024;
const OUTPUT_TAIL_LIMIT = 4 * 1024;
const TIMEOUT_KILL_GRACE_MS = 1_000;

export async function runToolCommand(
  tool: ToolConfig,
  changedFilePaths: readonly string[],
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<ToolCommandResult> {
  const command = expandChangedFilesToken(tool.command, changedFilePaths);
  const [executable, ...args] = command;

  if (!executable) {
    return {
      passed: false,
      detail: "command was empty",
    };
  }

  const commandResult = await runTimedCommand({
    args,
    command: executable,
    cwd: repoRoot,
    env,
    killGraceMs: TIMEOUT_KILL_GRACE_MS,
    outputCaptureLimit: OUTPUT_CAPTURE_LIMIT,
    outputTailLimit: OUTPUT_TAIL_LIMIT,
    timeoutSeconds: tool.timeout_seconds,
  });

  if (commandResult.kind === "spawn-error") {
    return {
      passed: false,
      detail: `failed to start: ${commandResult.error.message}`,
      outputTail: commandResult.outputTail,
    };
  }

  if (commandResult.kind === "timeout") {
    return {
      passed: false,
      detail: `timed out after ${String(tool.timeout_seconds)}s`,
      outputTail: commandResult.outputTail,
    };
  }

  if (commandResult.code === 0) {
    return { passed: true };
  }

  return {
    passed: false,
    detail:
      commandResult.code === null
        ? `ended by signal ${commandResult.signal ?? "unknown"}`
        : `exited with code ${String(commandResult.code)}`,
    outputTail: commandResult.outputTail,
  };
}

export function expandChangedFilesToken(
  command: readonly string[],
  changedFilePaths: readonly string[],
): string[] {
  return command.flatMap((token) =>
    token === CHANGED_FILES_TOKEN ? [...changedFilePaths] : [token],
  );
}

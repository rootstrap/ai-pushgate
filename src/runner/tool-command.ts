import type { ToolConfig } from "../config/index.js";
import {
  formatProcessFailure,
  runProcessOutcome,
} from "../process/outcome-policy.js";

export const CHANGED_FILES_TOKEN = "{changed_files}" as const;

export interface ToolCommandResult {
  passed: boolean;
  detail?: string;
  outputTail?: string;
}

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

  const commandResult = await runProcessOutcome({
    args,
    command: executable,
    cwd: repoRoot,
    env,
    timeoutSeconds: tool.timeout_seconds,
  });

  if (commandResult.kind === "passed") {
    return { passed: true };
  }

  return {
    passed: false,
    detail: formatProcessFailure(commandResult.failure),
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

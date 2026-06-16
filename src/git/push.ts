import { runInheritedCommand } from "../process/inherited-command.js";

export interface GitPushResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function runGitPush(
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
  },
): Promise<GitPushResult> {
  return runInheritedCommand({
    args,
    command: "git",
    env: options.env,
  });
}

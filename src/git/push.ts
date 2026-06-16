import { spawn } from "node:child_process";

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
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      env: options.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

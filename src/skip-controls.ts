import { spawn } from "node:child_process";

export const SKIP_ALL_CHECKS_CONFIG_KEY =
  "pushgate.skip-all-checks" as const;
export const SKIP_AI_CHECK_CONFIG_KEY = "pushgate.skip-ai-check" as const;

export interface SkipControlState {
  skipAllChecks: boolean;
  skipAiCheck: boolean;
}

export class SkipControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export function buildGitPushArgs(
  pushArgs: readonly string[],
  state: SkipControlState,
): string[] {
  const gitArgs: string[] = [];

  if (state.skipAllChecks) {
    gitArgs.push("-c", `${SKIP_ALL_CHECKS_CONFIG_KEY}=true`);
  } else if (state.skipAiCheck) {
    gitArgs.push("-c", `${SKIP_AI_CHECK_CONFIG_KEY}=true`);
  }

  gitArgs.push("push", ...pushArgs);

  return gitArgs;
}

export async function resolveSkipControlState(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SkipControlState> {
  const skipAllChecks = await readGitBooleanConfig(
    repoRoot,
    env,
    SKIP_ALL_CHECKS_CONFIG_KEY,
  );

  if (skipAllChecks) {
    return {
      skipAllChecks: true,
      skipAiCheck: false,
    };
  }

  return {
    skipAllChecks: false,
    skipAiCheck: await readGitBooleanConfig(
      repoRoot,
      env,
      SKIP_AI_CHECK_CONFIG_KEY,
    ),
  };
}

function readGitBooleanConfig(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  key: string,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["config", "--bool", "--get", key], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (data: string) => {
      stdout += data;
    });
    child.stderr?.on("data", (data: string) => {
      stderr += data;
    });
    child.on("error", (error) => {
      reject(
        new SkipControlError(
          `Failed to read Git config ${key}: ${error.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      const trimmedStdout = stdout.trim();
      const trimmedStderr = stderr.trim();

      if (code === 0) {
        if (trimmedStdout === "true") {
          resolve(true);
          return;
        }

        if (trimmedStdout === "false") {
          resolve(false);
          return;
        }

        reject(
          new SkipControlError(
            `Git config ${key} returned ${JSON.stringify(trimmedStdout)} instead of a boolean value.`,
          ),
        );
        return;
      }

      if (code === 1 && trimmedStderr === "") {
        resolve(false);
        return;
      }

      reject(
        new SkipControlError(
          `Could not read Git config ${key}. git config exited with ${String(code)}.${trimmedStderr ? ` ${trimmedStderr}` : ""}`,
        ),
      );
    });
  });
}

import {
  GitConfigError,
  readGitBooleanConfig,
} from "./git/config.js";

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
  const skipAllChecks = await readSkipBooleanConfig(
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
    skipAiCheck: await readSkipBooleanConfig(
      repoRoot,
      env,
      SKIP_AI_CHECK_CONFIG_KEY,
    ),
  };
}

async function readSkipBooleanConfig(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  key: string,
): Promise<boolean> {
  try {
    return await readGitBooleanConfig(repoRoot, key, env);
  } catch (error) {
    if (error instanceof GitConfigError) {
      throw new SkipControlError(error.message);
    }

    throw error;
  }
}

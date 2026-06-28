import {
  GitConfigError,
  readGitBooleanConfig,
} from "./git/config.js";

export const SKIP_ALL_CHECKS_CONFIG_KEY =
  "pushgate.skip-all-checks" as const;
export const SKIP_AI_CHECK_CONFIG_KEY = "pushgate.skip-ai-check" as const;

export type ActiveSkipControl =
  | {
      configKey: typeof SKIP_ALL_CHECKS_CONFIG_KEY;
      kind: "skip-all-checks";
    }
  | {
      configKey: typeof SKIP_AI_CHECK_CONFIG_KEY;
      kind: "skip-ai-check";
    }
  | {
      kind: "none";
    };

export interface SkipControlState {
  active: ActiveSkipControl;
  skipAllChecks: boolean;
  skipAiCheck: boolean;
}

export class SkipControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export function createSkipControlState(options: {
  skipAllChecks: boolean;
  skipAiCheck: boolean;
}): SkipControlState {
  if (options.skipAllChecks) {
    return {
      active: {
        configKey: SKIP_ALL_CHECKS_CONFIG_KEY,
        kind: "skip-all-checks",
      },
      skipAllChecks: true,
      skipAiCheck: false,
    };
  }

  if (options.skipAiCheck) {
    return {
      active: {
        configKey: SKIP_AI_CHECK_CONFIG_KEY,
        kind: "skip-ai-check",
      },
      skipAllChecks: false,
      skipAiCheck: true,
    };
  }

  return {
    active: {
      kind: "none",
    },
    skipAllChecks: false,
    skipAiCheck: false,
  };
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
    return createSkipControlState({
      skipAllChecks: true,
      skipAiCheck: false,
    });
  }

  return createSkipControlState({
    skipAllChecks: false,
    skipAiCheck: await readSkipBooleanConfig(
      repoRoot,
      env,
      SKIP_AI_CHECK_CONFIG_KEY,
    ),
  });
}

async function readSkipBooleanConfig(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  key: string,
): Promise<boolean> {
  try {
    return await readGitBooleanConfig(repoRoot, key, env, {
      preserveGitConfigOverlay: true,
    });
  } catch (error) {
    if (error instanceof GitConfigError) {
      throw new SkipControlError(error.message);
    }

    throw error;
  }
}

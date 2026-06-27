const GIT_LOCAL_ENV_VARS = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
]);

const GIT_CONFIG_PAIR_ENV_VAR = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

export interface SanitizeGitLocalEnvOptions {
  /**
   * Keep `git -c` config passed through Git's environment protocol.
   * Use only when intentionally reading caller-supplied Git config overlays.
   */
  preserveGitConfigOverlay?: boolean;
}

/**
 * Removes Git hook-local repository bindings from an environment copy.
 *
 * Git hooks can run with `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and
 * related variables pointing at the repository being pushed. If Pushgate passes
 * those variables into tools, plugins, providers, or explicit-`cwd` Git helpers,
 * nested Git commands may operate on the hook repo instead of their own cwd.
 */
export function sanitizeGitLocalEnv(
  env: NodeJS.ProcessEnv,
  options: SanitizeGitLocalEnvOptions = {},
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(env)) {
    if (shouldRemoveGitEnvVar(key, options)) {
      continue;
    }

    if (value !== undefined) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/** Returns true for repository-local Git environment variables. */
export function isGitLocalEnvVar(key: string): boolean {
  return GIT_LOCAL_ENV_VARS.has(key) || GIT_CONFIG_PAIR_ENV_VAR.test(key);
}

function shouldRemoveGitEnvVar(
  key: string,
  options: SanitizeGitLocalEnvOptions,
): boolean {
  if (options.preserveGitConfigOverlay && isGitConfigOverlayEnvVar(key)) {
    return false;
  }

  return isGitLocalEnvVar(key);
}

function isGitConfigOverlayEnvVar(key: string): boolean {
  return (
    key === "GIT_CONFIG_COUNT" ||
    key === "GIT_CONFIG_PARAMETERS" ||
    GIT_CONFIG_PAIR_ENV_VAR.test(key)
  );
}

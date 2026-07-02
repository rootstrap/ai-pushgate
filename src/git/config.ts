import { runGit } from "./command.js";

export class GitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export async function readGitBooleanConfig(
  repoRoot: string,
  key: string,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    preserveGitConfigOverlay?: boolean;
  } = {},
): Promise<boolean> {
  let result: Awaited<ReturnType<typeof runGit>>;

  try {
    result = await runGit(repoRoot, ["config", "--bool", "--get", key], {
      env,
      preserveGitConfigOverlay: options.preserveGitConfigOverlay,
    });
  } catch (error) {
    throw new GitConfigError(
      `Failed to read Git config ${key}: ${errorMessage(error)}`,
    );
  }

  const trimmedStdout = result.stdout.trim();
  const trimmedStderr = result.stderr.trim();

  if (result.code === 0) {
    if (trimmedStdout === "true") {
      return true;
    }

    if (trimmedStdout === "false") {
      return false;
    }

    throw new GitConfigError(
      `Git config ${key} returned ${JSON.stringify(trimmedStdout)} instead of a boolean value.`,
    );
  }

  if (result.code === 1 && trimmedStderr === "") {
    return false;
  }

  throw new GitConfigError(
    `Could not read Git config ${key}. git config exited with ${String(result.code)}.${trimmedStderr ? ` ${trimmedStderr}` : ""}`,
  );
}

export async function readGitStringConfig(
  repoRoot: string,
  key: string,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    preserveGitConfigOverlay?: boolean;
  } = {},
): Promise<string | undefined> {
  let result: Awaited<ReturnType<typeof runGit>>;

  try {
    result = await runGit(repoRoot, ["config", "--get", key], {
      env,
      preserveGitConfigOverlay: options.preserveGitConfigOverlay,
    });
  } catch (error) {
    throw new GitConfigError(
      `Failed to read Git config ${key}: ${errorMessage(error)}`,
    );
  }

  const trimmedStdout = result.stdout.trim();
  const trimmedStderr = result.stderr.trim();

  if (result.code === 0) {
    return trimmedStdout;
  }

  if (result.code === 1 && trimmedStderr === "") {
    return undefined;
  }

  throw new GitConfigError(
    `Could not read Git config ${key}. git config exited with ${String(result.code)}.${trimmedStderr ? ` ${trimmedStderr}` : ""}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

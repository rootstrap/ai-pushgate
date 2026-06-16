import {
  runCommand,
  type CommandResult,
  type RunCommandOptions,
} from "../process/run-command.js";

export type GitCommandEncoding = "buffer" | "utf8";
export type GitCommandResult<Stdout extends Buffer | string = string> =
  CommandResult<Stdout>;
type GitCommandFailureResult = Pick<
  GitCommandResult<Buffer | string>,
  "code" | "stderr"
>;

export interface GitCommandOptions {
  encoding?: GitCommandEncoding;
  env?: NodeJS.ProcessEnv;
}

export class GitCommandError extends Error {
  readonly gitArgs: string[];
  readonly result: GitCommandResult<Buffer | string>;

  constructor(
    gitArgs: readonly string[],
    result: GitCommandResult<Buffer | string>,
  ) {
    super(gitResultDetail(result));
    this.name = new.target.name;
    this.gitArgs = [...gitArgs];
    this.result = result;
  }
}

export function runGit(
  repoRoot: string,
  args: readonly string[],
  options: GitCommandOptions & { encoding: "buffer" },
): Promise<GitCommandResult<Buffer>>;
export function runGit(
  repoRoot: string,
  args: readonly string[],
  options?: GitCommandOptions & { encoding?: "utf8" },
): Promise<GitCommandResult<string>>;
export function runGit(
  repoRoot: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<GitCommandResult<Buffer> | GitCommandResult<string>> {
  const commandOptions: RunCommandOptions = {
    args,
    command: "git",
    cwd: repoRoot,
    env: options.env,
  };

  if (options.encoding === "buffer") {
    return runCommand({
      ...commandOptions,
      outputEncoding: "buffer",
    });
  }

  return runCommand({
    ...commandOptions,
    outputEncoding: "utf8",
  });
}

export function runGitChecked(
  repoRoot: string,
  args: readonly string[],
  options: GitCommandOptions & { encoding: "buffer" },
): Promise<Buffer>;
export function runGitChecked(
  repoRoot: string,
  args: readonly string[],
  options?: GitCommandOptions & { encoding?: "utf8" },
): Promise<string>;
export async function runGitChecked(
  repoRoot: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<Buffer | string> {
  const result =
    options.encoding === "buffer"
      ? await runGit(repoRoot, args, {
          ...options,
          encoding: "buffer",
        })
      : await runGit(repoRoot, args, {
          ...options,
          encoding: "utf8",
        });

  if (result.code !== 0) {
    throw new GitCommandError(args, result);
  }

  return result.stdout;
}

function gitResultDetail(result: GitCommandFailureResult): string {
  const stderr = result.stderr.trim();

  if (stderr) {
    return stderr;
  }

  return `git exited with ${String(result.code)}.`;
}

import {
  GitCommandError,
  runGit,
  runGitChecked,
  type GitCommandResult,
} from "../git/command.js";
import {
  gitFailure,
  gitResultDetail,
  gitSpawnFailure,
  MissingDiffBaseError,
  MissingTargetRefError,
} from "./errors.js";

export interface ChangedFilesDiffOutput {
  nameStatus: GitDiffCommandOutput;
  numstat: GitDiffCommandOutput;
}

interface GitDiffCommandOutput {
  args: readonly string[];
  output: Buffer;
}

export async function resolveTargetCommit(
  repoRoot: string,
  targetRef: string,
): Promise<string> {
  const args = ["rev-parse", "--verify", "--quiet", `${targetRef}^{commit}`];
  const result = await runChangedFilesGit(repoRoot, args);

  if (result.code === 0) {
    return result.stdout.trim();
  }

  if (result.code === 1) {
    throw new MissingTargetRefError(targetRef);
  }

  throw gitFailure(args, result);
}

export async function resolveDiffBase(
  repoRoot: string,
  targetRef: string,
  targetCommit: string,
): Promise<string> {
  const args = ["merge-base", targetCommit, "HEAD"];
  const result = await runChangedFilesGit(repoRoot, args);

  if (result.code === 0) {
    return result.stdout.trim();
  }

  throw new MissingDiffBaseError(targetRef, gitResultDetail(result));
}

export async function readChangedFileDiffs(
  repoRoot: string,
  reviewRange: string,
): Promise<ChangedFilesDiffOutput> {
  const nameStatusArgs = [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    "--no-ext-diff",
    reviewRange,
  ];
  const numstatArgs = [
    "diff",
    "--numstat",
    "-z",
    "--find-renames",
    "--no-ext-diff",
    reviewRange,
  ];
  const [nameStatusOutput, numstatOutput] = await Promise.all([
    readChangedFilesGitOutput(repoRoot, nameStatusArgs),
    readChangedFilesGitOutput(repoRoot, numstatArgs),
  ]);

  return {
    nameStatus: {
      args: nameStatusArgs,
      output: nameStatusOutput,
    },
    numstat: {
      args: numstatArgs,
      output: numstatOutput,
    },
  };
}

async function readChangedFilesGitOutput(
  repoRoot: string,
  args: readonly string[],
): Promise<Buffer> {
  try {
    return await runGitChecked(repoRoot, args, { encoding: "buffer" });
  } catch (error) {
    if (error instanceof GitCommandError) {
      throw gitFailure(args, error.result);
    }

    throw gitSpawnFailure(args, error);
  }
}

async function runChangedFilesGit(
  repoRoot: string,
  args: readonly string[],
): Promise<GitCommandResult<string>> {
  try {
    return await runGit(repoRoot, args);
  } catch (error) {
    throw gitSpawnFailure(args, error);
  }
}

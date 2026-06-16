import type { GitRunResult } from "./types.js";

/** Base error shape for changed-file Git and policy resolution failures. */
export class ChangedFilePolicyError extends Error {
  /** Stable machine-readable error code for callers to render. */
  readonly code: string;
  /** Human-readable context callers can include in diagnostic output. */
  readonly diagnostics: string[];

  constructor(message: string, code: string, diagnostics: string[] = []) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

/** Raised when the configured `review.target_branch` cannot resolve locally. */
export class MissingTargetRefError extends ChangedFilePolicyError {
  readonly targetRef: string;

  constructor(targetRef: string) {
    super(
      `Configured review.target_branch "${targetRef}" cannot be resolved locally. Fetch or create that ref before Pushgate resolves changed files.`,
      "PUSHGATE_PATH_TARGET_REF_MISSING",
    );
    this.targetRef = targetRef;
  }
}

/** Raised when the configured target and HEAD have no usable merge base. */
export class MissingDiffBaseError extends ChangedFilePolicyError {
  readonly targetRef: string;

  constructor(targetRef: string, detail?: string) {
    super(
      [
        `No usable diff base exists between review.target_branch "${targetRef}" and HEAD.`,
        "Pushgate does not guess a fallback changed-file range.",
        detail,
      ]
        .filter(Boolean)
        .join(" "),
      "PUSHGATE_PATH_DIFF_BASE_MISSING",
      detail ? [detail] : [],
    );
    this.targetRef = targetRef;
  }
}

/** Raised when Git cannot inspect or describe the changed-file set. */
export class GitChangedFilesError extends ChangedFilePolicyError {
  readonly gitArgs: readonly string[];

  constructor(gitArgs: readonly string[], detail: string) {
    super(
      `Git could not inspect Pushgate changed files with "git ${gitArgs.join(
        " ",
      )}". ${detail}`,
      "PUSHGATE_PATH_GIT_FAILED",
      [detail],
    );
    this.gitArgs = [...gitArgs];
  }
}

export function malformedGitOutput(
  gitArgs: readonly string[],
  detail: string,
): GitChangedFilesError {
  return new GitChangedFilesError(
    gitArgs,
    `Git returned malformed output: ${detail}.`,
  );
}

export function gitFailure(
  gitArgs: readonly string[],
  result: GitRunResult,
): GitChangedFilesError {
  return new GitChangedFilesError(gitArgs, gitResultDetail(result));
}

export function gitSpawnFailure(
  gitArgs: readonly string[],
  error: unknown,
): GitChangedFilesError {
  const detail = error instanceof Error ? error.message : String(error);

  return new GitChangedFilesError(gitArgs, detail);
}

export function gitResultDetail(result: GitRunResult): string {
  const stderr = result.stderr.trim();

  if (stderr) {
    return stderr;
  }

  return `git exited with ${String(result.code)}.`;
}

import { spawn } from "node:child_process";

import ignore from "ignore";

/** Git file states normalized for downstream Pushgate policy consumers. */
export type ChangedFileStatus =
  | "added"
  | "copied"
  | "deleted"
  | "modified"
  | "renamed"
  | "type-changed"
  | "unmerged"
  | "unknown";

/** One changed path as reported by the configured Pushgate diff range. */
export interface ChangedFile {
  /** Repository-relative path with Git's slash-separated path spelling. */
  path: string;
  /** Prior path when Git identified a rename or copy. */
  previousPath?: string;
  /** Normalized status from Git's name-status record. */
  status: ChangedFileStatus;
  /** Whether Git's numstat output identifies the diff as binary. */
  binary: boolean;
}

/** Options consumed by the changed-file resolver. */
export interface ResolveChangedFilesOptions {
  /** Repository root where Git commands should execute. */
  repoRoot?: string;
  /** Configured `review.target_branch` ref used for the triple-dot diff. */
  targetBranch: string;
  /** Configured gitignore-like `ignore_paths` patterns. */
  ignorePaths?: readonly string[];
}

/** File list plus Git metadata needed for later runner diagnostics. */
export interface ChangedFileResolution {
  /** Merge base selected by the `<target>...HEAD` diff contract. */
  diffBase: string;
  /** Globally filtered changed files for deterministic and AI consumers. */
  files: ChangedFile[];
  /** Commit selected by the configured target ref at resolution time. */
  targetCommit: string;
  /** Configured target branch or ref. */
  targetRef: string;
}

interface GitRunResult {
  code: number | null;
  stderr: string;
  stdout: Buffer;
}

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

/**
 * Resolve Git changes from the configured target ref to HEAD.
 *
 * The target must already exist locally. This resolver intentionally keeps
 * remote fetch and fallback range decisions out of path-policy execution.
 */
export async function resolveChangedFiles(
  options: ResolveChangedFilesOptions,
): Promise<ChangedFileResolution> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const targetCommit = await resolveTargetCommit(repoRoot, options.targetBranch);
  const diffBase = await resolveDiffBase(
    repoRoot,
    options.targetBranch,
    targetCommit,
  );
  const diffRange = `${targetCommit}...HEAD`;
  const nameStatusArgs = [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    "--no-ext-diff",
    diffRange,
  ];
  const numstatArgs = [
    "diff",
    "--numstat",
    "-z",
    "--find-renames",
    "--no-ext-diff",
    diffRange,
  ];
  const [nameStatusOutput, numstatOutput] = await Promise.all([
    runGitChecked(repoRoot, nameStatusArgs),
    runGitChecked(repoRoot, numstatArgs),
  ]);
  const binaryPaths = parseBinaryPaths(numstatOutput, numstatArgs);
  const files = filterIgnoredChangedFiles(
    parseChangedFiles(nameStatusOutput, binaryPaths, nameStatusArgs),
    options.ignorePaths ?? [],
  );

  return {
    diffBase,
    files,
    targetCommit,
    targetRef: options.targetBranch,
  };
}

/** Apply v2 `ignore_paths` rules to repository-relative changed paths. */
export function filterIgnoredChangedFiles(
  files: readonly ChangedFile[],
  ignorePaths: readonly string[],
): ChangedFile[] {
  if (ignorePaths.length === 0) {
    return [...files];
  }

  const ignorePathsMatcher = ignore().add(ignorePaths);

  return files.filter((file) => !ignorePathsMatcher.ignores(file.path));
}

/**
 * Select paths that later deterministic tool commands may receive as argv.
 *
 * Deleted files stay in the normalized resolver output for diff and AI work,
 * but they are not live paths that a changed-file command can receive.
 */
export function selectToolChangedFilePaths(
  files: readonly ChangedFile[],
  extensions?: readonly string[],
): string[] {
  return files
    .filter((file) => file.status !== "deleted")
    .filter((file) => matchesExtension(file.path, extensions))
    .map((file) => file.path);
}

async function resolveTargetCommit(
  repoRoot: string,
  targetRef: string,
): Promise<string> {
  const args = ["rev-parse", "--verify", "--quiet", `${targetRef}^{commit}`];
  const result = await runGit(repoRoot, args);

  if (result.code === 0) {
    return result.stdout.toString("utf8").trim();
  }

  if (result.code === 1) {
    throw new MissingTargetRefError(targetRef);
  }

  throw gitFailure(args, result);
}

async function resolveDiffBase(
  repoRoot: string,
  targetRef: string,
  targetCommit: string,
): Promise<string> {
  const args = ["merge-base", targetCommit, "HEAD"];
  const result = await runGit(repoRoot, args);

  if (result.code === 0) {
    return result.stdout.toString("utf8").trim();
  }

  throw new MissingDiffBaseError(targetRef, gitResultDetail(result));
}

async function runGitChecked(
  repoRoot: string,
  args: readonly string[],
): Promise<Buffer> {
  const result = await runGit(repoRoot, args);

  if (result.code !== 0) {
    throw gitFailure(args, result);
  }

  return result.stdout;
}

function parseChangedFiles(
  output: Buffer,
  binaryPaths: ReadonlySet<string>,
  gitArgs: readonly string[],
): ChangedFile[] {
  const fields = splitNullFields(output);
  const files: ChangedFile[] = [];

  for (let index = 0; index < fields.length; ) {
    const rawStatus = requiredField(fields, index, gitArgs, "status");
    const status = normalizeGitStatus(rawStatus);
    const needsPreviousPath = status === "renamed" || status === "copied";

    index += 1;

    if (needsPreviousPath) {
      const previousPath = requiredPath(fields, index, gitArgs);
      const path = requiredPath(fields, index + 1, gitArgs);

      files.push({
        binary: binaryPaths.has(path),
        path,
        previousPath,
        status,
      });
      index += 2;
      continue;
    }

    const path = requiredPath(fields, index, gitArgs);

    files.push({
      binary: binaryPaths.has(path),
      path,
      status,
    });
    index += 1;
  }

  return files;
}

function parseBinaryPaths(
  output: Buffer,
  gitArgs: readonly string[],
): Set<string> {
  const fields = splitNullFields(output);
  const binaryPaths = new Set<string>();

  for (let index = 0; index < fields.length; index += 1) {
    const summary = requiredField(fields, index, gitArgs, "numstat summary");
    const firstTab = summary.indexOf("\t");
    const secondTab = summary.indexOf("\t", firstTab + 1);

    if (firstTab === -1 || secondTab === -1) {
      throw malformedGitOutput(gitArgs, "a numstat summary had no tab fields");
    }

    const addedLines = summary.slice(0, firstTab);
    const deletedLines = summary.slice(firstTab + 1, secondTab);
    let path = summary.slice(secondTab + 1);

    if (path === "") {
      // Rename and copy numstat records keep preimage and current paths after
      // the summary field so NUL remains the only pathname delimiter.
      requiredPath(fields, index + 1, gitArgs);
      path = requiredPath(fields, index + 2, gitArgs);
      index += 2;
    }

    if (addedLines === "-" && deletedLines === "-") {
      binaryPaths.add(path);
    }
  }

  return binaryPaths;
}

function splitNullFields(output: Buffer): string[] {
  if (output.length === 0) {
    return [];
  }

  const fields = output.toString("utf8").split("\0");

  if (fields.at(-1) === "") {
    fields.pop();
  }

  return fields;
}

function normalizeGitStatus(rawStatus: string): ChangedFileStatus {
  switch (rawStatus[0]) {
    case "A":
      return "added";
    case "C":
      return "copied";
    case "D":
      return "deleted";
    case "M":
      return "modified";
    case "R":
      return "renamed";
    case "T":
      return "type-changed";
    case "U":
      return "unmerged";
    default:
      return "unknown";
  }
}

function matchesExtension(
  path: string,
  extensions: readonly string[] | undefined,
): boolean {
  if (extensions === undefined) {
    return true;
  }

  return extensions.some((extension) => path.endsWith(extension));
}

function requiredPath(
  fields: readonly string[],
  index: number,
  gitArgs: readonly string[],
): string {
  const path = requiredField(fields, index, gitArgs, "path");

  if (path === "") {
    throw malformedGitOutput(gitArgs, "a changed path was empty");
  }

  return path;
}

function requiredField(
  fields: readonly string[],
  index: number,
  gitArgs: readonly string[],
  label: string,
): string {
  const field = fields[index];

  if (field === undefined) {
    throw malformedGitOutput(gitArgs, `a ${label} field was missing`);
  }

  return field;
}

function malformedGitOutput(
  gitArgs: readonly string[],
  detail: string,
): GitChangedFilesError {
  return new GitChangedFilesError(gitArgs, `Git returned malformed output: ${detail}.`);
}

function gitFailure(
  gitArgs: readonly string[],
  result: GitRunResult,
): GitChangedFilesError {
  return new GitChangedFilesError(gitArgs, gitResultDetail(result));
}

function gitResultDetail(result: GitRunResult): string {
  const stderr = result.stderr.trim();

  if (stderr) {
    return stderr;
  }

  return `git exited with ${String(result.code)}.`;
}

function runGit(repoRoot: string, args: readonly string[]): Promise<GitRunResult> {
  return new Promise<GitRunResult>((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stderr = "";

    if (!child.stdout || !child.stderr) {
      reject(new Error("Git changed-file inspection must capture output."));
      return;
    }

    child.stdout.on("data", (data: Buffer) => {
      stdout.push(data);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code,
        stderr,
        stdout: Buffer.concat(stdout),
      });
    });
  }).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);

    throw new GitChangedFilesError(args, detail);
  });
}

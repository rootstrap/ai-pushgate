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
  /** Added text lines from Git numstat, or null when Git reports a binary diff. */
  additions: number | null;
  /** Deleted text lines from Git numstat, or null when Git reports a binary diff. */
  deletions: number | null;
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

export interface GitRunResult {
  code: number | null;
  stderr: string;
}

export interface ChangedFileDiffStats {
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

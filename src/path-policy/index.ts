import { parseChangedFiles, parseDiffStats } from "./diff-parsers.js";
export {
  ChangedFilePolicyError,
  GitChangedFilesError,
  MissingDiffBaseError,
  MissingTargetRefError,
} from "./errors.js";
import { filterIgnoredChangedFiles as applyIgnorePathFiltering } from "./filtering.js";
export {
  filterIgnoredChangedFiles,
  selectToolChangedFilePaths,
} from "./filtering.js";
import {
  readChangedFileDiffs,
  resolveDiffBase,
  resolveTargetCommit,
} from "./git-resolution.js";
export type {
  ChangedFile,
  ChangedFileResolution,
  ChangedFileStatus,
  ResolveChangedFilesOptions,
} from "./types.js";
import type {
  ChangedFileResolution,
  ResolveChangedFilesOptions,
} from "./types.js";

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
  const ranges = buildChangedFileRanges({ diffBase, targetCommit });
  const diffOutput = await readChangedFileDiffs(repoRoot, ranges.reviewRange);
  const diffStats = parseDiffStats(
    diffOutput.numstat.output,
    diffOutput.numstat.args,
  );
  const files = applyIgnorePathFiltering(
    parseChangedFiles(
      diffOutput.nameStatus.output,
      diffStats,
      diffOutput.nameStatus.args,
    ),
    options.ignorePaths ?? [],
  );

  return {
    diffBase,
    files,
    reviewRange: ranges.reviewRange,
    scanRange: ranges.scanRange,
    targetCommit,
    targetRef: options.targetBranch,
  };
}

function buildChangedFileRanges(options: {
  diffBase: string;
  targetCommit: string;
}): Pick<ChangedFileResolution, "reviewRange" | "scanRange"> {
  return {
    reviewRange: `${options.targetCommit}...HEAD`,
    scanRange: `${options.diffBase}..HEAD`,
  };
}

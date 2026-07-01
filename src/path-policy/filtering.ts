import ignore from "ignore";

import type { ChangedFile } from "./types.js";

export interface SelectLiveChangedFilePathsOptions {
  extensions?: readonly string[];
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

export function countChangedTextLines(files: readonly ChangedFile[]): number {
  return files.reduce((total, file) => {
    if (file.binary) {
      return total;
    }

    return total + (file.additions ?? 0) + (file.deletions ?? 0);
  }, 0);
}

export function isLiveChangedFile(file: ChangedFile): boolean {
  return file.status !== "deleted";
}

export function selectLiveChangedFiles(
  files: readonly ChangedFile[],
): ChangedFile[] {
  return files.filter(isLiveChangedFile);
}

export function selectLiveChangedFilePaths(
  files: readonly ChangedFile[],
  options: SelectLiveChangedFilePathsOptions = {},
): string[] {
  return selectLiveChangedFiles(files)
    .filter((file) => matchesExtension(file.path, options.extensions))
    .map((file) => file.path);
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
  return selectLiveChangedFilePaths(files, { extensions });
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

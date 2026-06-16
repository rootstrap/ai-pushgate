import ignore from "ignore";

import type { ChangedFile } from "./types.js";

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

function matchesExtension(
  path: string,
  extensions: readonly string[] | undefined,
): boolean {
  if (extensions === undefined) {
    return true;
  }

  return extensions.some((extension) => path.endsWith(extension));
}

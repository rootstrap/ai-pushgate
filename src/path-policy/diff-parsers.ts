import { malformedGitOutput } from "./errors.js";
import type {
  ChangedFile,
  ChangedFileDiffStats,
  ChangedFileStatus,
} from "./types.js";

export function parseChangedFiles(
  output: Buffer,
  diffStats: ReadonlyMap<string, ChangedFileDiffStats>,
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
      const stats = statsForPath(diffStats, path);

      files.push({
        ...stats,
        path,
        previousPath,
        status,
      });
      index += 2;
      continue;
    }

    const path = requiredPath(fields, index, gitArgs);
    const stats = statsForPath(diffStats, path);

    files.push({
      ...stats,
      path,
      status,
    });
    index += 1;
  }

  return files;
}

export function parseDiffStats(
  output: Buffer,
  gitArgs: readonly string[],
): Map<string, ChangedFileDiffStats> {
  const fields = splitNullFields(output);
  const diffStats = new Map<string, ChangedFileDiffStats>();

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

    diffStats.set(
      path,
      parseNumstatLineCounts(addedLines, deletedLines, gitArgs),
    );
  }

  return diffStats;
}

function parseNumstatLineCounts(
  addedLines: string,
  deletedLines: string,
  gitArgs: readonly string[],
): ChangedFileDiffStats {
  if (addedLines === "-" && deletedLines === "-") {
    return {
      additions: null,
      binary: true,
      deletions: null,
    };
  }

  const additions = Number(addedLines);
  const deletions = Number(deletedLines);

  if (
    !isNonNegativeIntegerString(addedLines) ||
    !isNonNegativeIntegerString(deletedLines) ||
    !Number.isInteger(additions) ||
    !Number.isInteger(deletions)
  ) {
    throw malformedGitOutput(
      gitArgs,
      `a numstat line count was not numeric: ${addedLines}/${deletedLines}`,
    );
  }

  return {
    additions,
    binary: false,
    deletions,
  };
}

function isNonNegativeIntegerString(value: string): boolean {
  return /^\d+$/.test(value);
}

function statsForPath(
  diffStats: ReadonlyMap<string, ChangedFileDiffStats>,
  path: string,
): ChangedFileDiffStats {
  return (
    diffStats.get(path) ?? {
      additions: 0,
      binary: false,
      deletions: 0,
    }
  );
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

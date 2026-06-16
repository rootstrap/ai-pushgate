import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ReviewConfig } from "../config/index.js";
import { GitCommandError, runGitChecked } from "../git/command.js";
import type {
  ChangedFile,
  ChangedFileResolution,
} from "../path-policy/index.js";
import type {
  LocalAiFullFileContext,
  LocalAiReviewPayload,
} from "./types.js";
import reviewPromptMarkdown from "./prompts/review-prompt.md";

const MAX_FULL_FILE_BYTES = 50 * 1024;

export const BASE_REVIEW_PROMPT = reviewPromptMarkdown;

export async function buildLocalAiReviewPayload(options: {
  changedFileResolution: ChangedFileResolution;
  env?: NodeJS.ProcessEnv;
  repoRoot: string;
  reviewConfig: ReviewConfig;
}): Promise<LocalAiReviewPayload> {
  const changedFiles = [...options.changedFileResolution.files];

  if (changedFiles.length === 0) {
    return {
      changedFiles,
      diff: "",
      diffLineCount: 0,
      fullFiles: [],
      prompt: renderLocalAiPrompt({
        changedFiles,
        diff: "",
        fullFiles: [],
      }),
    };
  }

  const diff = await collectReviewDiff({
    changedFileResolution: options.changedFileResolution,
    contextLines: options.reviewConfig.context_lines,
    env: options.env ?? process.env,
    repoRoot: options.repoRoot,
  });
  const diffLineCount = countTextLines(diff);
  const fullFiles =
    diffLineCount < options.reviewConfig.max_lines_for_full_file
      ? await collectFullFiles(options.repoRoot, changedFiles)
      : [];

  return {
    changedFiles,
    diff,
    diffLineCount,
    fullFiles,
    prompt: renderLocalAiPrompt({
      changedFiles,
      diff,
      fullFiles,
    }),
  };
}

export function renderLocalAiPrompt(options: {
  changedFiles: readonly ChangedFile[];
  diff: string;
  fullFiles: readonly LocalAiFullFileContext[];
}): string {
  const sections = [
    BASE_REVIEW_PROMPT.trimEnd(),
    "",
    "## Changed Files",
    formatChangedFiles(options.changedFiles),
    "",
    "=== DIFF ===",
    options.diff,
  ];

  if (options.fullFiles.length > 0) {
    sections.push("", "=== FILES ===", formatFullFiles(options.fullFiles));
  }

  return sections.join("\n").trimEnd() + "\n";
}

async function collectReviewDiff(options: {
  changedFileResolution: ChangedFileResolution;
  contextLines: number;
  env: NodeJS.ProcessEnv;
  repoRoot: string;
}): Promise<string> {
  const filePaths = options.changedFileResolution.files.map((file) => file.path);
  const args = [
    "diff",
    `-U${String(options.contextLines)}`,
    "--no-ext-diff",
    `${options.changedFileResolution.targetCommit}...HEAD`,
    "--",
    ...filePaths,
  ];

  try {
    return await runGitChecked(options.repoRoot, args, {
      env: options.env,
    });
  } catch (error) {
    if (error instanceof GitCommandError) {
      const stderr = error.result.stderr.trim();

      throw new Error(
        `git diff failed while building the local AI review payload.${stderr ? ` ${stderr}` : ""}`,
      );
    }

    throw error;
  }
}

async function collectFullFiles(
  repoRoot: string,
  changedFiles: readonly ChangedFile[],
): Promise<LocalAiFullFileContext[]> {
  const fullFiles: LocalAiFullFileContext[] = [];

  for (const file of changedFiles) {
    if (file.status === "deleted") {
      continue;
    }

    if (file.binary) {
      fullFiles.push({
        path: file.path,
        content: "",
        note: "binary file omitted",
        truncated: false,
      });
      continue;
    }

    try {
      const contents = await readFile(join(repoRoot, file.path));

      if (contents.length > MAX_FULL_FILE_BYTES) {
        fullFiles.push({
          path: file.path,
          content:
            `${contents.subarray(0, MAX_FULL_FILE_BYTES).toString("utf8")}\n... [file truncated]\n`,
          note: `truncated to ${String(MAX_FULL_FILE_BYTES)} bytes`,
          truncated: true,
        });
        continue;
      }

      fullFiles.push({
        path: file.path,
        content: contents.toString("utf8"),
        truncated: false,
      });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;

      if (err.code === "ENOENT") {
        fullFiles.push({
          path: file.path,
          content: "",
          note: "file disappeared before local AI review",
          truncated: false,
        });
        continue;
      }

      throw error;
    }
  }

  return fullFiles;
}

function formatChangedFiles(changedFiles: readonly ChangedFile[]): string {
  if (changedFiles.length === 0) {
    return "(none)";
  }

  return changedFiles
    .map((file) => `- ${file.path}${describeChangedFile(file)}`)
    .join("\n");
}

function describeChangedFile(file: ChangedFile): string {
  const details: string[] = [];

  if (file.status === "renamed" && file.previousPath) {
    details.push(`renamed from ${file.previousPath}`);
  } else if (file.status !== "modified") {
    details.push(file.status);
  }

  if (file.binary) {
    details.push("binary");
  } else if (file.additions !== null && file.deletions !== null) {
    details.push(`+${String(file.additions)}/-${String(file.deletions)}`);
  }

  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

function formatFullFiles(fullFiles: readonly LocalAiFullFileContext[]): string {
  return fullFiles
    .map((file) => {
      const title = file.note
        ? `### FILE: ${file.path} (${file.note})`
        : `### FILE: ${file.path}`;

      return [title, file.content].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function countTextLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  const newlineCount = text.match(/\n/g)?.length ?? 0;

  if (newlineCount === 0) {
    return 1;
  }

  return text.endsWith("\n") ? newlineCount : newlineCount + 1;
}

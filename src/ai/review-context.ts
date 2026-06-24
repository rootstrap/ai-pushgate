import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ReviewConfig } from "../config/index.js";
import { GitCommandError, runGitChecked } from "../git/command.js";
import type {
  ChangedFile,
  ChangedFileResolution,
} from "../path-policy/index.js";
import { renderLocalAiPrompt } from "./review-prompt.js";
import type {
  LocalAiFullFileContext,
  LocalAiReviewContext,
  LocalAiReviewPayload,
} from "./types.js";

const MAX_FULL_FILE_BYTES = 50 * 1024;

export async function buildLocalAiReviewPayload(options: {
  changedFileResolution: ChangedFileResolution;
  env?: NodeJS.ProcessEnv;
  repoRoot: string;
  reviewConfig: ReviewConfig;
}): Promise<LocalAiReviewPayload> {
  const reviewContext = await collectLocalAiReviewContext(options);

  return {
    ...reviewContext,
    prompt: renderLocalAiPrompt(reviewContext),
  };
}

export async function collectLocalAiReviewContext(options: {
  changedFileResolution: ChangedFileResolution;
  env?: NodeJS.ProcessEnv;
  repoRoot: string;
  reviewConfig: ReviewConfig;
}): Promise<LocalAiReviewContext> {
  const changedFiles = [...options.changedFileResolution.files];

  if (changedFiles.length === 0) {
    return {
      changedFiles,
      diff: "",
      diffLineCount: 0,
      fullFiles: [],
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
  };
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
    options.changedFileResolution.reviewRange,
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

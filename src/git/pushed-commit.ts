import { existsSync } from "node:fs";
import { mkdtemp, rm, stat, symlink, unlink } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { runGit, runGitChecked } from "./command.js";

/** Commit that Pushgate evaluates, as shown in the terminal. */
export interface PushedCommit {
  /** Full object name of the commit being pushed. */
  sha: string;
  /** Abbreviated object name for display. */
  shortSha: string;
  /** First line of the commit message. */
  subject: string;
}

/** Disposable checkout of the pushed commit. Call `dispose` exactly once when done. */
export interface PushedCommitWorktree {
  /** Absolute path of the detached checkout; `HEAD` here is the pushed commit. */
  path: string;
  /** Removes the worktree and its temp directory. Safe to call repeatedly. */
  dispose(): Promise<void>;
}

const ZERO_SHA = /^0+$/;
const WORKTREE_DIR_PREFIX = "pushgate-worktree-";
const STALE_WORKTREE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Pick the commit Git is about to push.
 *
 * Uses the first non-delete ref update from pre-push stdin so checks follow what
 * is pushed rather than whatever happens to be checked out. Falls back to `HEAD`
 * for manual runs without hook input. Returns `null` when no commit can be
 * resolved at all (for example an empty repository).
 */
export async function resolvePushedCommit(options: {
  branchUpdates: readonly { localSha: string }[];
  env: NodeJS.ProcessEnv;
  repoRoot: string;
}): Promise<PushedCommit | null> {
  const update = options.branchUpdates.find(
    (candidate) => !ZERO_SHA.test(candidate.localSha),
  );

  return (
    (update ? await readCommit(options, update.localSha) : null) ??
    (await readCommit(options, "HEAD"))
  );
}

async function readCommit(
  options: { env: NodeJS.ProcessEnv; repoRoot: string },
  rev: string,
): Promise<PushedCommit | null> {
  const result = await runGit(
    options.repoRoot,
    ["log", "-1", "--format=%H%x00%h%x00%s", `${rev}^{commit}`, "--"],
    { env: options.env },
  );

  if (result.code !== 0) {
    return null;
  }

  const [sha = "", shortSha = "", subject = ""] = result.stdout
    .trimEnd()
    .split("\0");

  return { sha, shortSha, subject };
}

/** Whether the checkout has staged, unstaged, or untracked (non-ignored) changes. */
export async function hasUncommittedChanges(options: {
  env: NodeJS.ProcessEnv;
  repoRoot: string;
}): Promise<boolean> {
  const result = await runGit(
    options.repoRoot,
    ["status", "--porcelain", "--untracked-files=normal"],
    { env: options.env },
  );

  return result.code === 0 && result.stdout.trim().length > 0;
}

/**
 * Check out `commit` into a temporary detached worktree.
 *
 * Checks run here so uncommitted edits in the developer's tree can neither fail
 * nor rescue a push. Git hooks are disabled for the checkout so user
 * `post-checkout` hooks do not fire. A top-level `node_modules` is symlinked in
 * because gitignored dependencies are otherwise absent from the checkout.
 */
export async function createPushedCommitWorktree(options: {
  commit: PushedCommit;
  env: NodeJS.ProcessEnv;
  repoRoot: string;
}): Promise<PushedCommitWorktree> {
  await pruneStaleWorktrees(options.repoRoot, options.env);

  const tempDir = await mkdtemp(join(tmpdir(), WORKTREE_DIR_PREFIX));
  const path = join(tempDir, "checkout");
  const nodeModulesLink = join(path, "node_modules");
  let disposed = false;

  const dispose = async (): Promise<void> => {
    if (disposed) {
      return;
    }

    disposed = true;
    // Unlink first so recursive removal can never follow into the real node_modules.
    await unlink(nodeModulesLink).catch(() => undefined);
    await runGit(
      options.repoRoot,
      ["worktree", "remove", "--force", path],
      { env: options.env },
    ).catch(() => undefined);
    await rm(tempDir, { force: true, recursive: true });
  };

  try {
    await runGitChecked(
      options.repoRoot,
      [
        "-c",
        `core.hooksPath=${devNull}`,
        "worktree",
        "add",
        "--detach",
        path,
        options.commit.sha,
      ],
      { env: options.env },
    );

    const sourceNodeModules = join(options.repoRoot, "node_modules");

    if (existsSync(sourceNodeModules) && !existsSync(nodeModulesLink)) {
      await symlink(sourceNodeModules, nodeModulesLink, "dir");
    }
  } catch (error) {
    await dispose();
    throw error;
  }

  return { dispose, path };
}

/**
 * Remove Pushgate worktrees abandoned by a hard kill (SIGKILL, power loss).
 *
 * Only worktrees under Pushgate's own temp-dir prefix and older than a day are
 * removed, so concurrent pushes are never disturbed.
 */
async function pruneStaleWorktrees(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await runGit(repoRoot, ["worktree", "prune"], { env });

  const listing = await runGit(repoRoot, ["worktree", "list", "--porcelain"], {
    env,
  });

  if (listing.code !== 0) {
    return;
  }

  for (const line of listing.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) {
      continue;
    }

    const path = line.slice("worktree ".length);
    const tempDir = dirname(path);

    if (
      basename(path) !== "checkout" ||
      !basename(tempDir).startsWith(WORKTREE_DIR_PREFIX)
    ) {
      continue;
    }

    const info = await stat(tempDir).catch(() => null);

    if (info && Date.now() - info.mtimeMs < STALE_WORKTREE_AGE_MS) {
      continue;
    }

    await runGit(repoRoot, ["worktree", "remove", "--force", path], { env });
    await rm(tempDir, { force: true, recursive: true });
  }
}

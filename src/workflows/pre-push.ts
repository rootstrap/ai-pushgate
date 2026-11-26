import { basename } from "node:path";

import { loadConfig } from "../config/index.js";
import {
  createPushedCommitWorktree,
  hasUncommittedChanges,
  resolvePushedCommit,
  type PushedCommit,
} from "../git/pushed-commit.js";
import { runGit } from "../git/command.js";
import { resolveGitRepositoryRoot } from "../git/repository.js";
import {
  resolveSkipControlState,
  SKIP_ALL_CHECKS_CONFIG_KEY,
} from "../skip-controls.js";
import {
  writeAttentionRow,
  writeDetail,
  writeHeader,
  writeLine,
  writeResultRow,
  writeSection,
} from "../terminal/format.js";
import { PUSHGATE_VERSION } from "../version.js";
import { runLocalPushGate } from "./local-push-gate-run.js";
import {
  buildPrePushContext,
  readPrePushInputFromStdin,
  type PrePushHookContext,
} from "./pre-push-hook-context.js";
import type { ReviewTargetSelector } from "./review-target-selection.js";
import type { WarningConfirmer } from "./warning-confirmation.js";

export {
  parsePrePushLine,
  parseBranchFromPrePushLine,
  readPrePushInputFromStdin,
  readPrePushBranchFromStdin,
} from "./pre-push-hook-context.js";

export interface PrePushWorkflowIO {
  env: NodeJS.ProcessEnv;
  hookArgs?: readonly string[];
  reviewTargetSelector?: ReviewTargetSelector;
  stderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  warningConfirmer?: WarningConfirmer;
}

export async function runPrePushWorkflow(
  io: PrePushWorkflowIO,
): Promise<number> {
  const prePushInput = await readPrePushInputFromStdin(io.stdin);
  const hookContext = buildPrePushContext({
    args: io.hookArgs ?? [],
    branch: undefined,
    input: prePushInput,
  });

  const repoRoot = await resolveGitRepositoryRoot(io.env);
  writePrePushHeader(io.stdout, repoRoot, hookContext);

  const skipControls = await resolveSkipControlState(repoRoot, io.env);

  if (skipControls.active.kind === "skip-all-checks") {
    writeSkipAllChecksReason(io.stdout);
    return 0;
  }

  const currentBranch = await resolveCheckedOutBranch(repoRoot, io.env);
  const pushedCommit = await resolvePushedCommit({
    branchUpdates: hookContext.branchUpdates,
    env: io.env,
    repoRoot,
  });

  if (pushedCommit === null) {
    // Nothing committed yet (manual run in an empty repository): there is no
    // pushed state to isolate, so evaluate the working directory as-is.
    return await runInCheckout(repoRoot);
  }

  const dirty = await hasUncommittedChanges({ env: io.env, repoRoot });

  writePushedCommitNotice(io.stdout, pushedCommit, dirty);

  // Everything below runs in a detached checkout of the pushed commit so that
  // uncommitted edits cannot change (or rescue) the result.
  const worktree = await createPushedCommitWorktree({
    commit: pushedCommit,
    env: io.env,
    repoRoot,
  });
  const onSignal = (signal: NodeJS.Signals): void => {
    void worktree.dispose().finally(() => {
      process.kill(process.pid, signal);
    });
  };

  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

  for (const signal of signals) {
    process.once(signal, onSignal);
  }

  try {
    return await runInCheckout(worktree.path);
  } finally {
    for (const signal of signals) {
      process.off(signal, onSignal);
    }
    await worktree.dispose();
  }

  async function runInCheckout(checkoutRoot: string): Promise<number> {
    const loaded = await loadConfig(checkoutRoot);

    for (const warning of loaded.warnings) {
      io.stdout.write(`[pushgate] Warning: ${warning}\n`);
    }

    return await runLocalPushGate({
      config: loaded.config,
      ...(currentBranch ? { currentBranch } : {}),
      env: io.env,
      hookContext,
      repoRoot: checkoutRoot,
      ...(io.reviewTargetSelector
        ? { reviewTargetSelector: io.reviewTargetSelector }
        : {}),
      stdout: io.stdout,
      skipControls,
      ...(io.warningConfirmer
        ? { warningConfirmer: io.warningConfirmer }
        : {}),
    });
  }
}

async function resolveCheckedOutBranch(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const result = await runGit(
    repoRoot,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    { env },
  );

  return result.code === 0 ? result.stdout.trim() : undefined;
}

function writePushedCommitNotice(
  stdout: NodeJS.WritableStream,
  commit: PushedCommit,
  dirty: boolean,
): void {
  writeSection(stdout, "Pushed commit");
  writeDetail(stdout, `Commit: ${commit.shortSha} (${commit.sha})`);
  writeDetail(stdout, `Subject: ${commit.subject}`);

  if (dirty) {
    writeAttentionRow(
      stdout,
      "Uncommitted files",
      "Checks run on the commit above. Staged, unstaged, and untracked changes are NOT included.",
    );
  }

  writeLine(stdout);
}

function writeSkipAllChecksReason(stdout: NodeJS.WritableStream): void {
  writeResultRow(
    stdout,
    "skipped",
    `Skipping all local Pushgate checks because ${SKIP_ALL_CHECKS_CONFIG_KEY}=true.`,
  );
}

function writePrePushHeader(
  stdout: NodeJS.WritableStream,
  repoRoot: string,
  context: PrePushHookContext,
): void {
  const lines = [
    `Pushgate v${PUSHGATE_VERSION} - pre-push`,
    `Repo: ${basename(repoRoot)}`,
  ];

  if (context.branch) {
    lines.push(`Branch: ${context.branch}`);
  }

  if (context.remote) {
    lines.push(`Remote: ${context.remote}`);
  }

  writeHeader(stdout, lines);
}

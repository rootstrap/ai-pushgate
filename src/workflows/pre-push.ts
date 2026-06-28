import { basename } from "node:path";

import { loadConfig } from "../config/index.js";
import { resolveGitRepositoryRoot } from "../git/repository.js";
import {
  resolveSkipControlState,
  SKIP_ALL_CHECKS_CONFIG_KEY,
} from "../skip-controls.js";
import {
  writeHeader,
  writeResultRow,
} from "../terminal/format.js";
import { PUSHGATE_VERSION } from "../version.js";
import { runLocalPushGate } from "./local-push-gate-run.js";
import {
  buildPrePushContext,
  readPrePushBranchFromStdin,
  type PrePushHookContext,
} from "./pre-push-hook-context.js";
import type { WarningConfirmer } from "./warning-confirmation.js";

export {
  parseBranchFromPrePushLine,
  readPrePushBranchFromStdin,
} from "./pre-push-hook-context.js";

export interface PrePushWorkflowIO {
  env: NodeJS.ProcessEnv;
  hookArgs?: readonly string[];
  stderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  warningConfirmer?: WarningConfirmer;
}

export async function runPrePushWorkflow(
  io: PrePushWorkflowIO,
): Promise<number> {
  const hookContext = buildPrePushContext({
    args: io.hookArgs ?? [],
    branch: await readPrePushBranchFromStdin(io.stdin),
  });

  const repoRoot = await resolveGitRepositoryRoot(io.env);
  writePrePushHeader(io.stdout, repoRoot, hookContext);

  const skipControls = await resolveSkipControlState(repoRoot, io.env);

  if (skipControls.active.kind === "skip-all-checks") {
    writeSkipAllChecksReason(io.stdout);
    return 0;
  }

  const loaded = await loadConfig(repoRoot);

  for (const warning of loaded.warnings) {
    io.stdout.write(`[pushgate] Warning: ${warning}\n`);
  }

  return await runLocalPushGate({
    config: loaded.config,
    env: io.env,
    repoRoot,
    stdout: io.stdout,
    skipControls,
    ...(io.warningConfirmer
      ? { warningConfirmer: io.warningConfirmer }
      : {}),
  });
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

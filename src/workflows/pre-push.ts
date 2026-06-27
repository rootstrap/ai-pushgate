import { basename } from "node:path";

import { runLocalAiReview } from "../ai/index.js";
import { loadConfig, type PushgateConfig } from "../config/index.js";
import { resolveGitRepositoryRoot } from "../git/repository.js";
import {
  resolveChangedFiles,
  type ChangedFileResolution,
} from "../path-policy/index.js";
import { runDeterministicChecks } from "../runner/deterministic.js";
import { resolveSkipControlState } from "../skip-controls.js";
import {
  writeDetail,
  writeHeader,
  writeLine,
  writeResultRow,
  writeSection,
} from "../terminal/format.js";
import { PUSHGATE_VERSION } from "../version.js";
import {
  buildPrePushConfigDecision,
  buildPrePushRunDecision,
  formatRunSkipReason,
  type LocalAiPhaseDecision,
  type PrePushRunDecision,
  type RunSkipReason,
} from "./run-decisions.js";
import {
  createTerminalWarningConfirmer,
  WarningConfirmationError,
  type WarningConfirmationPhase,
  type WarningConfirmer,
} from "./warning-confirmation.js";

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
    stdin: await readStdin(io.stdin),
  });

  const repoRoot = await resolveGitRepositoryRoot(io.env);
  writePrePushHeader(io.stdout, repoRoot, hookContext);

  const skipControls = await resolveSkipControlState(repoRoot, io.env);
  const configDecision = buildPrePushConfigDecision(skipControls);

  if (configDecision.kind === "skip") {
    writeVisibleSkipReason(io.stdout, configDecision.reason);
    return 0;
  }

  const loaded = await loadConfig(repoRoot);

  for (const warning of loaded.warnings) {
    io.stdout.write(`[pushgate] Warning: ${warning}\n`);
  }

  const runDecision = buildPrePushRunDecision(loaded.config, skipControls);
  const changedFileResolution = await maybeResolveChangedFiles(loaded.config, {
    repoRoot,
    runDecision,
  });

  const summary = await runDeterministicChecks({
    changedFileResolution,
    config: loaded.config,
    env: io.env,
    repoRoot,
    stdout: io.stdout,
  });

  if (summary.exitCode !== 0) {
    return summary.exitCode;
  }

  if (
    !(await confirmWarningsBeforeContinuing({
      confirmer: io.warningConfirmer,
      phase: "deterministic checks",
      stdout: io.stdout,
      warningCount: summary.results.filter(
        (result) => result.status === "warning",
      ).length,
    }))
  ) {
    return 1;
  }

  const localAiSummary = await runLocalAiPhase(
    loaded.config,
    runDecision.localAi,
    changedFileResolution,
    {
      env: io.env,
      repoRoot,
      stdout: io.stdout,
    },
  );

  if (localAiSummary.exitCode !== 0) {
    return localAiSummary.exitCode;
  }

  if (
    !(await confirmWarningsBeforeContinuing({
      confirmer: io.warningConfirmer,
      phase: "local AI review",
      stdout: io.stdout,
      warningCount: localAiSummary.warningCount,
    }))
  ) {
    return 1;
  }

  writeLine(io.stdout);
  writeLine(io.stdout, "Pushgate passed. Git is pushing...");
  return 0;
}

async function runLocalAiPhase(
  config: PushgateConfig,
  decision: LocalAiPhaseDecision,
  changedFileResolution: ChangedFileResolution | null,
  options: {
    env: NodeJS.ProcessEnv;
    repoRoot: string;
    stdout: NodeJS.WritableStream;
  },
): Promise<{ exitCode: number; warningCount: number }> {
  if (decision.kind === "skip") {
    const message = formatRunSkipReason(decision.reason);

    if (message !== null) {
      writeSection(options.stdout, "AI review");
      writeResultRow(options.stdout, "skipped", message);
    }

    return { exitCode: 0, warningCount: 0 };
  }

  writeSection(options.stdout, "AI review");

  return await runLocalAiReview({
    aiConfig: config.ai,
    changedFileResolution: requireChangedFileResolution(
      changedFileResolution,
      "local AI phase",
    ),
    env: options.env,
    repoRoot: options.repoRoot,
    reviewConfig: config.review,
    stdout: options.stdout,
  });
}

async function confirmWarningsBeforeContinuing(options: {
  confirmer: WarningConfirmer | undefined;
  phase: WarningConfirmationPhase;
  stdout: NodeJS.WritableStream;
  warningCount: number;
}): Promise<boolean> {
  if (options.warningCount === 0) {
    return true;
  }

  const confirmer = options.confirmer ?? createTerminalWarningConfirmer();

  try {
    const confirmed = await confirmer({
      phase: options.phase,
      warningCount: options.warningCount,
    });

    if (confirmed) {
      options.stdout.write(
        `Continuing with ${String(options.warningCount)} warning(s) from ${options.phase} after confirmation.\n`,
      );
      return true;
    }

    options.stdout.write(
      `Push blocked because ${options.phase} produced ${String(options.warningCount)} warning(s) and continuation was not confirmed.\n`,
    );
    return false;
  } catch (error) {
    if (error instanceof WarningConfirmationError) {
      options.stdout.write(`${error.message}\n`);
      options.stdout.write(
        "Push blocked because warning confirmation could not be collected.\n",
      );
      return false;
    }

    throw error;
  }
}

async function maybeResolveChangedFiles(
  config: PushgateConfig,
  options: {
    repoRoot: string;
    runDecision: PrePushRunDecision;
  },
): Promise<ChangedFileResolution | null> {
  if (options.runDecision.changedFiles.kind === "not-required") {
    return null;
  }

  return await resolveChangedFiles({
    repoRoot: options.repoRoot,
    targetBranch: config.review.target_branch,
    ignorePaths: config.ignore_paths,
  });
}

function writeVisibleSkipReason(
  stdout: NodeJS.WritableStream,
  reason: RunSkipReason,
): void {
  const message = formatRunSkipReason(reason);

  if (message !== null) {
    writeResultRow(stdout, "skipped", message);
  }
}

function requireChangedFileResolution(
  changedFileResolution: ChangedFileResolution | null,
  phaseName: string,
): ChangedFileResolution {
  if (changedFileResolution !== null) {
    return changedFileResolution;
  }

  throw new Error(
    `Pushgate could not prepare changed files for the ${phaseName}.`,
  );
}

interface PrePushContext {
  branch?: string;
  remote?: string;
}

function writePrePushHeader(
  stdout: NodeJS.WritableStream,
  repoRoot: string,
  context: PrePushContext,
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

function buildPrePushContext(options: {
  args: readonly string[];
  stdin: string;
}): PrePushContext {
  return {
    branch: parseBranchFromPrePushInput(options.stdin),
    remote: options.args[0],
  };
}

function parseBranchFromPrePushInput(input: string): string | undefined {
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    const [localRef] = trimmed.split(/\s+/, 1);

    if (localRef?.startsWith("refs/heads/")) {
      return localRef.slice("refs/heads/".length);
    }
  }

  return undefined;
}

function readStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    if ((stdin as { isTTY?: boolean }).isTTY) {
      resolve("");
      return;
    }

    let input = "";

    stdin.setEncoding("utf8");
    stdin.on("error", reject);
    stdin.on("data", (chunk: string) => {
      input += chunk;
    });
    stdin.on("end", () => {
      resolve(input);
    });
    stdin.resume();
  });
}

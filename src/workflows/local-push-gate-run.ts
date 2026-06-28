import { runLocalAiReview } from "../ai/index.js";
import type { PushgateConfig } from "../config/index.js";
import {
  resolveChangedFiles,
  type ChangedFileResolution,
} from "../path-policy/index.js";
import {
  buildDeterministicCheckPlan,
  runDeterministicChecks,
} from "../runner/deterministic.js";
import {
  SKIP_AI_CHECK_CONFIG_KEY,
  type SkipControlState,
} from "../skip-controls.js";
import {
  writeLine,
  writeResultRow,
  writeSection,
} from "../terminal/format.js";
import {
  createTerminalWarningConfirmer,
  WarningConfirmationError,
  type WarningConfirmationPhase,
  type WarningConfirmer,
} from "./warning-confirmation.js";

export interface LocalPushGateRunOptions {
  config: PushgateConfig;
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  skipControls: Pick<SkipControlState, "active">;
  stdout: NodeJS.WritableStream;
  warningConfirmer?: WarningConfirmer;
}

type LocalAiPhaseDecision =
  | {
      kind: "run";
    }
  | {
      kind: "skip";
      reason: "local-ai-mode-off" | "skip-ai-check";
    };

/**
 * Run the local push gate after repository context and config are already loaded.
 *
 * This module owns the local phase order: changed-file resolution, deterministic
 * checks, warning confirmation, local AI review, and the final pass/fail result.
 */
export async function runLocalPushGate(
  options: LocalPushGateRunOptions,
): Promise<number> {
  const localAi = getLocalAiPhaseDecision(options.config, options.skipControls);
  const changedFileResolution = await resolveChangedFilesIfRequired({
    config: options.config,
    localAi,
    repoRoot: options.repoRoot,
  });

  const deterministicSummary = await runDeterministicChecks({
    changedFileResolution,
    config: options.config,
    env: options.env,
    repoRoot: options.repoRoot,
    stdout: options.stdout,
  });

  if (deterministicSummary.exitCode !== 0) {
    return deterministicSummary.exitCode;
  }

  if (
    !(await confirmWarningsBeforeContinuing({
      confirmer: options.warningConfirmer,
      phase: "deterministic checks",
      stdout: options.stdout,
      warningCount: deterministicSummary.results.filter(
        (result) => result.status === "warning",
      ).length,
    }))
  ) {
    return 1;
  }

  const localAiSummary = await runLocalAiPhase({
    changedFileResolution,
    config: options.config,
    decision: localAi,
    env: options.env,
    repoRoot: options.repoRoot,
    stdout: options.stdout,
  });

  if (localAiSummary.exitCode !== 0) {
    return localAiSummary.exitCode;
  }

  if (
    !(await confirmWarningsBeforeContinuing({
      confirmer: options.warningConfirmer,
      phase: "local AI review",
      stdout: options.stdout,
      warningCount: localAiSummary.warningCount,
    }))
  ) {
    return 1;
  }

  writeLine(options.stdout);
  writeLine(options.stdout, "Pushgate passed. Git is pushing...");
  return 0;
}

async function resolveChangedFilesIfRequired(options: {
  config: PushgateConfig;
  localAi: LocalAiPhaseDecision;
  repoRoot: string;
}): Promise<ChangedFileResolution | null> {
  const deterministicPlan = buildDeterministicCheckPlan(options.config);

  if (
    !deterministicPlan.needsChangedFileResolution &&
    options.localAi.kind !== "run"
  ) {
    return null;
  }

  return await resolveChangedFiles({
    repoRoot: options.repoRoot,
    targetBranch: options.config.review.target_branch,
    ignorePaths: options.config.ignore_paths,
  });
}

async function runLocalAiPhase(options: {
  changedFileResolution: ChangedFileResolution | null;
  config: PushgateConfig;
  decision: LocalAiPhaseDecision;
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  stdout: NodeJS.WritableStream;
}): Promise<{ exitCode: number; warningCount: number }> {
  if (options.decision.kind === "skip") {
    const message = formatLocalAiSkipReason(options.decision.reason);

    if (message !== null) {
      writeSection(options.stdout, "AI review");
      writeResultRow(options.stdout, "skipped", message);
    }

    return { exitCode: 0, warningCount: 0 };
  }

  writeSection(options.stdout, "AI review");

  return await runLocalAiReview({
    aiConfig: options.config.ai,
    changedFileResolution: requireChangedFileResolution(
      options.changedFileResolution,
      "local AI phase",
    ),
    env: options.env,
    repoRoot: options.repoRoot,
    reviewConfig: options.config.review,
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

function getLocalAiPhaseDecision(
  config: PushgateConfig,
  skipControls: Pick<SkipControlState, "active">,
): LocalAiPhaseDecision {
  if (config.ai.mode === "off") {
    return {
      kind: "skip",
      reason: "local-ai-mode-off",
    };
  }

  if (skipControls.active.kind === "skip-ai-check") {
    return {
      kind: "skip",
      reason: "skip-ai-check",
    };
  }

  return { kind: "run" };
}

function formatLocalAiSkipReason(
  reason: Extract<LocalAiPhaseDecision, { kind: "skip" }>["reason"],
): string | null {
  if (reason === "local-ai-mode-off") {
    return null;
  }

  return `Skipping local AI because ${SKIP_AI_CHECK_CONFIG_KEY}=true.`;
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

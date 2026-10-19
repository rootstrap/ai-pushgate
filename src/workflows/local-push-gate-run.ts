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
  createPushgateTranscript,
  type LocalAiTranscript,
  type WarningConfirmationPhase,
  type WarningConfirmationTranscript,
} from "../transcript/index.js";
import type { SkipControlState } from "../skip-controls.js";
import type { PrePushHookContext } from "./pre-push-hook-context.js";
import {
  ReviewTargetSelectionError,
  selectReviewTarget,
  type ReviewTargetSelector,
} from "./review-target-selection.js";
import {
  createTerminalWarningConfirmer,
  WarningConfirmationError,
  type WarningConfirmer,
} from "./warning-confirmation.js";

export interface LocalPushGateRunOptions {
  config: PushgateConfig;
  env: NodeJS.ProcessEnv;
  hookContext: PrePushHookContext;
  repoRoot: string;
  reviewTargetSelector?: ReviewTargetSelector;
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
  const transcript = createPushgateTranscript(options.stdout);
  const localAi = getLocalAiPhaseDecision(options.config, options.skipControls);
  let changedFileResolution: ChangedFileResolution | null;

  try {
    changedFileResolution = await resolveChangedFilesIfRequired({
      config: options.config,
      env: options.env,
      hookContext: options.hookContext,
      localAi,
      repoRoot: options.repoRoot,
      reviewTargetSelector: options.reviewTargetSelector,
      transcript,
    });
  } catch (error) {
    if (error instanceof ReviewTargetSelectionError) {
      transcript.reviewTarget.writeUnavailable({ message: error.message });
      return 1;
    }

    throw error;
  }

  const deterministicSummary = await runDeterministicChecks({
    changedFileResolution,
    config: options.config,
    env: options.env,
    repoRoot: options.repoRoot,
    transcript: transcript.deterministic,
  });

  if (deterministicSummary.exitCode !== 0) {
    return deterministicSummary.exitCode;
  }

  if (
    !(await confirmWarningsBeforeContinuing({
      confirmer: options.warningConfirmer,
      phase: "deterministic checks",
      transcript: transcript.warningConfirmation,
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
    transcript: transcript.localAi,
  });

  if (localAiSummary.exitCode !== 0) {
    return localAiSummary.exitCode;
  }

  if (
    !(await confirmWarningsBeforeContinuing({
      confirmer: options.warningConfirmer,
      phase: "local AI review",
      transcript: transcript.warningConfirmation,
      warningCount: localAiSummary.warningCount,
    }))
  ) {
    return 1;
  }

  transcript.push.writePassed();
  return 0;
}

async function resolveChangedFilesIfRequired(options: {
  config: PushgateConfig;
  env: NodeJS.ProcessEnv;
  hookContext: PrePushHookContext;
  localAi: LocalAiPhaseDecision;
  repoRoot: string;
  reviewTargetSelector: ReviewTargetSelector | undefined;
  transcript: ReturnType<typeof createPushgateTranscript>;
}): Promise<ChangedFileResolution | null> {
  const deterministicPlan = buildDeterministicCheckPlan(options.config);

  if (
    !deterministicPlan.needsChangedFileResolution &&
    options.localAi.kind !== "run"
  ) {
    return null;
  }

  const selectedReviewTarget = await selectReviewTarget({
    configuredTargetRef: options.config.review.target_branch,
    env: options.env,
    hookContext: options.hookContext,
    onDiagnostics(diagnostics) {
      options.transcript.reviewTarget.writeDiagnostics(diagnostics);
    },
    repoRoot: options.repoRoot,
    selector: options.reviewTargetSelector,
  });
  const resolution = await resolveChangedFiles({
    repoRoot: options.repoRoot,
    targetBranch: selectedReviewTarget.ref,
    ignorePaths: options.config.ignore_paths,
  });

  options.transcript.reviewTarget.writeSelected({
    label: selectedReviewTarget.label,
    reviewRange: resolution.reviewRange,
    scanRange: resolution.scanRange,
  });

  return resolution;
}

async function runLocalAiPhase(options: {
  changedFileResolution: ChangedFileResolution | null;
  config: PushgateConfig;
  decision: LocalAiPhaseDecision;
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  transcript: LocalAiTranscript;
}): Promise<{ exitCode: number; warningCount: number }> {
  if (options.decision.kind === "skip") {
    options.transcript.writeSkipped({
      reason: options.decision.reason,
    });

    return { exitCode: 0, warningCount: 0 };
  }

  options.transcript.writeSection();

  return await runLocalAiReview({
    aiConfig: options.config.ai,
    changedFileResolution: requireChangedFileResolution(
      options.changedFileResolution,
      "local AI phase",
    ),
    env: options.env,
    repoRoot: options.repoRoot,
    reviewConfig: options.config.review,
    transcript: options.transcript,
  });
}

async function confirmWarningsBeforeContinuing(options: {
  confirmer: WarningConfirmer | undefined;
  phase: WarningConfirmationPhase;
  transcript: WarningConfirmationTranscript;
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
      options.transcript.writeConfirmed({
        phase: options.phase,
        warningCount: options.warningCount,
      });
      return true;
    }

    options.transcript.writeDeclined({
      phase: options.phase,
      warningCount: options.warningCount,
    });
    return false;
  } catch (error) {
    if (error instanceof WarningConfirmationError) {
      options.transcript.writeUnavailable({ message: error.message });
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

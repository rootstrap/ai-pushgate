import type { PushgateConfig } from "../config/index.js";
import { buildDeterministicCheckPlan } from "../runner/deterministic.js";
import {
  SKIP_AI_CHECK_CONFIG_KEY,
  SKIP_ALL_CHECKS_CONFIG_KEY,
  type SkipControlState,
} from "../skip-controls.js";

export type RunPhase = "deterministic-checks" | "local-ai-review";

export type RunSkipReason =
  | {
      configKey: typeof SKIP_ALL_CHECKS_CONFIG_KEY;
      control: "skip-all-checks";
      kind: "skip-control";
      scope: "all-local-checks";
    }
  | {
      configKey: typeof SKIP_AI_CHECK_CONFIG_KEY;
      control: "skip-ai-check";
      kind: "skip-control";
      scope: "local-ai";
    }
  | {
      kind: "local-ai-mode-off";
    };

export type PrePushConfigDecision =
  | {
      kind: "load-config";
    }
  | {
      kind: "skip";
      reason: RunSkipReason;
    };

export type ChangedFileResolutionDecision =
  | {
      kind: "required";
      requiredBy: RunPhase[];
    }
  | {
      kind: "not-required";
      requiredBy: [];
    };

export type DeterministicChecksDecision =
  | {
      checkCount: number;
      kind: "configured";
    }
  | {
      kind: "not-configured";
    };

export type LocalAiPhaseDecision =
  | {
      kind: "run";
    }
  | {
      kind: "skip";
      reason: RunSkipReason;
    };

export interface PrePushRunDecision {
  changedFiles: ChangedFileResolutionDecision;
  deterministicChecks: DeterministicChecksDecision;
  localAi: LocalAiPhaseDecision;
}

export function buildPrePushConfigDecision(
  skipControls: Pick<SkipControlState, "active">,
): PrePushConfigDecision {
  if (skipControls.active.kind === "skip-all-checks") {
    return {
      kind: "skip",
      reason: {
        configKey: SKIP_ALL_CHECKS_CONFIG_KEY,
        control: "skip-all-checks",
        kind: "skip-control",
        scope: "all-local-checks",
      },
    };
  }

  return { kind: "load-config" };
}

export function buildPrePushRunDecision(
  config: PushgateConfig,
  skipControls: Pick<SkipControlState, "active">,
): PrePushRunDecision {
  const deterministicPlan = buildDeterministicCheckPlan(config);
  const deterministicChecks = deterministicPlan.runChecks
    ? ({
        checkCount: deterministicPlan.checkCount,
        kind: "configured",
      } satisfies DeterministicChecksDecision)
    : ({
        kind: "not-configured",
      } satisfies DeterministicChecksDecision);
  const localAi = getLocalAiDecision(config, skipControls);

  return {
    changedFiles: getChangedFileResolutionDecision({
      deterministicChecks,
      localAi,
    }),
    deterministicChecks,
    localAi,
  };
}

export function formatRunSkipReason(reason: RunSkipReason): string | null {
  if (reason.kind === "local-ai-mode-off") {
    return null;
  }

  if (reason.control === "skip-all-checks") {
    return `Skipping all local Pushgate checks because ${reason.configKey}=true.`;
  }

  return `Skipping local AI because ${reason.configKey}=true.`;
}

function getLocalAiDecision(
  config: PushgateConfig,
  skipControls: Pick<SkipControlState, "active">,
): LocalAiPhaseDecision {
  if (config.ai.mode === "off") {
    return {
      kind: "skip",
      reason: {
        kind: "local-ai-mode-off",
      },
    };
  }

  if (skipControls.active.kind === "skip-ai-check") {
    return {
      kind: "skip",
      reason: {
        configKey: SKIP_AI_CHECK_CONFIG_KEY,
        control: "skip-ai-check",
        kind: "skip-control",
        scope: "local-ai",
      },
    };
  }

  return { kind: "run" };
}

function getChangedFileResolutionDecision(options: {
  deterministicChecks: DeterministicChecksDecision;
  localAi: LocalAiPhaseDecision;
}): ChangedFileResolutionDecision {
  const requiredBy: RunPhase[] = [];

  if (options.deterministicChecks.kind === "configured") {
    requiredBy.push("deterministic-checks");
  }

  if (options.localAi.kind === "run") {
    requiredBy.push("local-ai-review");
  }

  if (requiredBy.length === 0) {
    return {
      kind: "not-required",
      requiredBy: [],
    };
  }

  return {
    kind: "required",
    requiredBy,
  };
}

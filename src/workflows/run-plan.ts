import type { PushgateConfig } from "../config/index.js";
import { countBuiltInPolicies } from "../runner/policies.js";
import type { SkipControlState } from "../skip-controls.js";

export type LocalAiSkipReason = "mode-off" | "skip-control";

export interface PrePushRunPlan {
  deterministicCheckCount: number;
  runDeterministic: boolean;
  runLocalAi: boolean;
  localAiSkipReason: LocalAiSkipReason | null;
  needsChangedFiles: boolean;
}

export function buildPrePushRunPlan(
  config: PushgateConfig,
  skipControls: Pick<SkipControlState, "skipAiCheck">,
): PrePushRunPlan {
  const deterministicCheckCount =
    config.tools.length + countBuiltInPolicies(config.policies);
  const runDeterministic = deterministicCheckCount > 0;
  const localAiSkipReason = getLocalAiSkipReason(config, skipControls);
  const runLocalAi = localAiSkipReason === null;

  return {
    deterministicCheckCount,
    localAiSkipReason,
    needsChangedFiles: runDeterministic || runLocalAi,
    runDeterministic,
    runLocalAi,
  };
}

function getLocalAiSkipReason(
  config: PushgateConfig,
  skipControls: Pick<SkipControlState, "skipAiCheck">,
): LocalAiSkipReason | null {
  if (config.ai.mode === "off") {
    return "mode-off";
  }

  if (skipControls.skipAiCheck) {
    return "skip-control";
  }

  return null;
}

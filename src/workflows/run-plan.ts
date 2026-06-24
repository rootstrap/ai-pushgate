import type { PushgateConfig } from "../config/index.js";
import { buildDeterministicCheckPlan } from "../runner/deterministic.js";
import type { SkipControlState } from "../skip-controls.js";

export type LocalAiSkipReason = "mode-off" | "skip-control";

export interface PrePushRunPlan {
  runLocalAi: boolean;
  localAiSkipReason: LocalAiSkipReason | null;
  needsChangedFiles: boolean;
}

export function buildPrePushRunPlan(
  config: PushgateConfig,
  skipControls: Pick<SkipControlState, "skipAiCheck">,
): PrePushRunPlan {
  const deterministicPlan = buildDeterministicCheckPlan(config);
  const localAiSkipReason = getLocalAiSkipReason(config, skipControls);
  const runLocalAi = localAiSkipReason === null;

  return {
    localAiSkipReason,
    needsChangedFiles:
      deterministicPlan.needsChangedFileResolution || runLocalAi,
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

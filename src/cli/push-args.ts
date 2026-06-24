import {
  createSkipControlState,
  type SkipControlState,
} from "../skip-controls.js";

export interface PushCommandArgs {
  gitPushArgs: string[];
  skipControls: SkipControlState;
}

export function parsePushCommandArgs(
  args: readonly string[],
): PushCommandArgs {
  const gitPushArgs: string[] = [];
  let parsePushgateFlags = true;
  let skipAiCheck = false;
  let skipAllChecks = false;

  for (const arg of args) {
    if (parsePushgateFlags && arg === "--skip-all-checks") {
      skipAllChecks = true;
      continue;
    }

    if (parsePushgateFlags && arg === "--skip-ai-check") {
      skipAiCheck = true;
      continue;
    }

    if (arg === "--") {
      parsePushgateFlags = false;
    }

    gitPushArgs.push(arg);
  }

  return {
    gitPushArgs,
    skipControls: createSkipControlState({
      skipAllChecks,
      skipAiCheck,
    }),
  };
}

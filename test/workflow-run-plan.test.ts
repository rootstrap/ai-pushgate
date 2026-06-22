import assert from "node:assert/strict";
import test from "node:test";

import type { PushgateConfig } from "../src/config/index.js";
import { buildPrePushRunPlan } from "../src/workflows/run-plan.js";

test("skips changed-file planning when deterministic checks and local AI are inactive", () => {
  const plan = buildPrePushRunPlan(baseConfig(), { skipAiCheck: false });

  assert.deepEqual(plan, {
    deterministicCheckCount: 0,
    localAiSkipReason: "mode-off",
    needsChangedFiles: false,
    runDeterministic: false,
    runLocalAi: false,
  });
});

test("plans changed files for configured deterministic tools and policies", () => {
  const plan = buildPrePushRunPlan(
    baseConfig({
      policies: {
        diff_size: { max_changed_lines: 10, mode: "warning" },
        forbidden_paths: { mode: "blocking", patterns: ["secrets/**"] },
      },
      tools: [
        {
          command: ["pnpm", "test"],
          fail_fast: true,
          mode: "blocking",
          name: "test",
          run: "changed_files",
          timeout_seconds: 60,
        },
      ],
    }),
    { skipAiCheck: false },
  );

  assert.equal(plan.deterministicCheckCount, 3);
  assert.equal(plan.runDeterministic, true);
  assert.equal(plan.runLocalAi, false);
  assert.equal(plan.needsChangedFiles, true);
});

test("plans changed files for active local AI without deterministic checks", () => {
  const plan = buildPrePushRunPlan(
    baseConfig({
      ai: {
        ...baseConfig().ai,
        mode: "blocking",
        provider: "claude",
      },
    }),
    { skipAiCheck: false },
  );

  assert.deepEqual(plan, {
    deterministicCheckCount: 0,
    localAiSkipReason: null,
    needsChangedFiles: true,
    runDeterministic: false,
    runLocalAi: true,
  });
});

test("skip-ai-check removes local AI changed-file work", () => {
  const plan = buildPrePushRunPlan(
    baseConfig({
      ai: {
        ...baseConfig().ai,
        mode: "advisory",
        provider: "copilot",
      },
    }),
    { skipAiCheck: true },
  );

  assert.deepEqual(plan, {
    deterministicCheckCount: 0,
    localAiSkipReason: "skip-control",
    needsChangedFiles: false,
    runDeterministic: false,
    runLocalAi: false,
  });
});

function baseConfig(
  overrides: Partial<PushgateConfig> = {},
): PushgateConfig {
  return {
    ai: {
      max_changed_lines: 500,
      max_prompt_tokens: 12000,
      mode: "off",
      providers: {},
      timeout_seconds: 120,
    },
    ignore_paths: [],
    policies: {},
    review: {
      context_lines: 10,
      max_lines_for_full_file: 300,
      target_branch: "main",
    },
    tools: [],
    version: 2,
    ...overrides,
  };
}

import assert from "node:assert/strict";
import test from "node:test";

import type { PushgateConfig } from "../src/config/index.js";
import { createSkipControlState } from "../src/skip-controls.js";
import {
  buildPrePushConfigDecision,
  buildPrePushRunDecision,
  formatRunSkipReason,
} from "../src/workflows/run-decisions.js";

test("skip-all-checks owns the pre-config decision and visible reason", () => {
  const decision = buildPrePushConfigDecision(
    createSkipControlState({ skipAllChecks: true, skipAiCheck: true }),
  );

  assert.deepEqual(decision, {
    kind: "skip",
    reason: {
      configKey: "pushgate.skip-all-checks",
      control: "skip-all-checks",
      kind: "skip-control",
      scope: "all-local-checks",
    },
  });
  if (decision.kind !== "skip") {
    assert.fail("Expected skip-all-checks to skip before config loading.");
  }
  assert.equal(
    formatRunSkipReason(decision.reason),
    "Skipping all local Pushgate checks because pushgate.skip-all-checks=true.",
  );
});

test("skip-ai-check still allows config loading", () => {
  assert.deepEqual(
    buildPrePushConfigDecision(
      createSkipControlState({ skipAllChecks: false, skipAiCheck: true }),
    ),
    { kind: "load-config" },
  );
});

test("skips changed-file planning when deterministic checks and local AI are inactive", () => {
  const decision = buildPrePushRunDecision(
    baseConfig(),
    createSkipControlState({ skipAllChecks: false, skipAiCheck: false }),
  );

  assert.deepEqual(decision, {
    changedFiles: {
      kind: "not-required",
      requiredBy: [],
    },
    deterministicChecks: {
      kind: "not-configured",
    },
    localAi: {
      kind: "skip",
      reason: {
        kind: "local-ai-mode-off",
      },
    },
  });
  if (decision.localAi.kind !== "skip") {
    assert.fail("Expected local AI to be skipped when ai.mode is off.");
  }
  assert.equal(formatRunSkipReason(decision.localAi.reason), null);
});

test("plans changed files for configured deterministic tools and policies", () => {
  const decision = buildPrePushRunDecision(
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
    createSkipControlState({ skipAllChecks: false, skipAiCheck: false }),
  );

  assert.deepEqual(decision.changedFiles, {
    kind: "required",
    requiredBy: ["deterministic-checks"],
  });
  assert.deepEqual(decision.deterministicChecks, {
    checkCount: 3,
    kind: "configured",
  });
  assert.deepEqual(decision.localAi, {
    kind: "skip",
    reason: {
      kind: "local-ai-mode-off",
    },
  });
});

test("plans changed files for enabled deterministic plugins", () => {
  const decision = buildPrePushRunDecision(
    baseConfig({
      plugins: {
        gitleaks: {
          command: "gitleaks",
          enabled: true,
          fail_fast: true,
          mode: "blocking",
          redact: true,
          timeout_seconds: 60,
        },
      },
    }),
    createSkipControlState({ skipAllChecks: false, skipAiCheck: false }),
  );

  assert.deepEqual(decision.changedFiles, {
    kind: "required",
    requiredBy: ["deterministic-checks"],
  });
  assert.deepEqual(decision.deterministicChecks, {
    checkCount: 1,
    kind: "configured",
  });
});

test("skips disabled deterministic plugins", () => {
  const decision = buildPrePushRunDecision(
    baseConfig({
      plugins: {
        gitleaks: {
          command: "gitleaks",
          enabled: false,
          fail_fast: true,
          mode: "blocking",
          redact: true,
          timeout_seconds: 60,
        },
      },
    }),
    createSkipControlState({ skipAllChecks: false, skipAiCheck: false }),
  );

  assert.deepEqual(decision, {
    changedFiles: {
      kind: "not-required",
      requiredBy: [],
    },
    deterministicChecks: {
      kind: "not-configured",
    },
    localAi: {
      kind: "skip",
      reason: {
        kind: "local-ai-mode-off",
      },
    },
  });
});

test("plans changed files for active local AI without deterministic checks", () => {
  const decision = buildPrePushRunDecision(
    baseConfig({
      ai: {
        ...baseConfig().ai,
        mode: "blocking",
        provider: "claude",
      },
    }),
    createSkipControlState({ skipAllChecks: false, skipAiCheck: false }),
  );

  assert.deepEqual(decision.changedFiles, {
    kind: "required",
    requiredBy: ["local-ai-review"],
  });
  assert.deepEqual(decision.localAi, {
    kind: "run",
  });
});

test("skip-ai-check removes local AI changed-file work", () => {
  const decision = buildPrePushRunDecision(
    baseConfig({
      ai: {
        ...baseConfig().ai,
        mode: "advisory",
        provider: "copilot",
      },
    }),
    createSkipControlState({ skipAllChecks: false, skipAiCheck: true }),
  );

  assert.deepEqual(decision, {
    changedFiles: {
      kind: "not-required",
      requiredBy: [],
    },
    deterministicChecks: {
      kind: "not-configured",
    },
    localAi: {
      kind: "skip",
      reason: {
        configKey: "pushgate.skip-ai-check",
        control: "skip-ai-check",
        kind: "skip-control",
        scope: "local-ai",
      },
    },
  });
  if (decision.localAi.kind !== "skip") {
    assert.fail("Expected skip-ai-check to skip local AI.");
  }
  assert.equal(
    formatRunSkipReason(decision.localAi.reason),
    "Skipping local AI because pushgate.skip-ai-check=true.",
  );
});

test("skip-ai-check leaves deterministic changed-file work intact", () => {
  const decision = buildPrePushRunDecision(
    baseConfig({
      ai: {
        ...baseConfig().ai,
        mode: "blocking",
        provider: "claude",
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
    createSkipControlState({ skipAllChecks: false, skipAiCheck: true }),
  );

  assert.deepEqual(decision.changedFiles, {
    kind: "required",
    requiredBy: ["deterministic-checks"],
  });
  assert.deepEqual(decision.localAi, {
    kind: "skip",
    reason: {
      configKey: "pushgate.skip-ai-check",
      control: "skip-ai-check",
      kind: "skip-control",
      scope: "local-ai",
    },
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
    plugins: {},
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

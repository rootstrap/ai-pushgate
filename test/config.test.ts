import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConfigValidationError,
  LegacyConfigError,
  MissingConfigError,
  loadConfig,
  parseConfigYaml,
} from "../src/config/index.js";
import type { PushgateConfig } from "../src/config/index.js";

const fixtureRoot = new URL("./fixtures/config/", import.meta.url);
const templatesRoot = new URL("../templates/", import.meta.url);

test("parses a representative v2 config with nested provider settings", async () => {
  const config = await parseFixture("valid.yml");

  assert.deepEqual(config.review, {
    target_branch: "develop",
    context_lines: 14,
    max_lines_for_full_file: 450,
  });
  assert.deepEqual(config.tools[0].command, [
    "npx",
    "eslint",
    "{changed_files}",
  ]);
  assert.deepEqual(config.tools[0].extensions, [".js", ".ts"]);
  assert.equal(config.tools[0].timeout_seconds, 12);
  assert.equal(config.tools[0].mode, "warning");
  assert.equal(config.tools[0].run, "changed_files");
  assert.equal(config.tools[0].fail_fast, false);
  assert.deepEqual(config.policies, {
    diff_size: {
      max_changed_lines: 250,
      mode: "warning",
    },
    forbidden_paths: {
      patterns: [".env", "secrets/**"],
      mode: "blocking",
    },
  });
  assert.equal(config.ai.mode, "advisory");
  assert.equal(config.ai.max_changed_lines, 750);
  assert.equal(config.ai.max_prompt_tokens, 16_000);
  assert.equal(config.ai.timeout_seconds, 90);
  assert.deepEqual(config.ai.providers.claude.transport, {
    auth: { source: "cli" },
    flags: ["quiet"],
  });
});

test("normalizes defaults before later Pushgate layers consume config", async () => {
  const config = await parseFixture("defaults.yml");

  assert.deepEqual(config, {
    version: 2,
    review: {
      target_branch: "main",
      context_lines: 10,
      max_lines_for_full_file: 300,
    },
    tools: [],
    policies: {},
    ai: {
      mode: "blocking",
      max_changed_lines: 500,
      max_prompt_tokens: 12_000,
      timeout_seconds: 120,
      provider: "claude",
      providers: { claude: {} },
    },
    ignore_paths: [],
  });
});

test("normalizes deterministic tool execution defaults", () => {
  const config = parseConfigYaml(
    [
      "version: 2",
      "ai:",
      "  mode: off",
      "tools:",
      "  - name: eslint",
      '    command: ["npx", "eslint", "{changed_files}"]',
    ].join("\n"),
    "tool-defaults.yml",
  );

  assert.deepEqual(config.tools[0], {
    name: "eslint",
    command: ["npx", "eslint", "{changed_files}"],
    timeout_seconds: 60,
    mode: "blocking",
    run: "changed_files",
    fail_fast: true,
  });
});

test("normalizes built-in policy defaults", () => {
  const config = parseConfigYaml(
    [
      "version: 2",
      "ai:",
      "  mode: off",
      "policies:",
      "  diff_size:",
      "    max_changed_lines: 200",
      "  forbidden_paths:",
      "    patterns:",
      "      - .env",
      "      - secrets/**",
    ].join("\n"),
    "policy-defaults.yml",
  );

  assert.deepEqual(config.policies, {
    diff_size: {
      max_changed_lines: 200,
      mode: "blocking",
    },
    forbidden_paths: {
      patterns: [".env", "secrets/**"],
      mode: "blocking",
    },
  });
});

test("rejects missing and unsupported config versions", () => {
  assertValidationError("ai:\n  mode: off\n", /missing required key "version"/);
  assertValidationError("version: 1\nai:\n  mode: off\n", /\/version must equal 2/);
});

test("rejects missing tool keys, unknown core keys, and invalid AI modes", () => {
  assertValidationError(
    "version: 2\nai:\n  mode: off\ntools:\n  - command: [npx, eslint]\n",
    /missing required key "name"/,
  );
  assertValidationError(
    "version: 2\nagent: {}\nai:\n  mode: off\n",
    /contains unknown key "agent"/,
  );
  assertValidationError(
    "version: 2\nai:\n  mode: warn\n",
    /\/ai\/mode must be equal to one of the allowed values/,
  );
});

test("rejects invalid AI guardrail settings", () => {
  assertValidationError(
    [
      "version: 2",
      "ai:",
      "  mode: off",
      "  max_changed_lines: 0",
    ].join("\n"),
    /\/ai\/max_changed_lines must be >= 1/,
  );
  assertValidationError(
    [
      "version: 2",
      "ai:",
      "  mode: off",
      "  max_prompt_tokens: 0",
    ].join("\n"),
    /\/ai\/max_prompt_tokens must be >= 1/,
  );
  assertValidationError(
    [
      "version: 2",
      "ai:",
      "  mode: off",
      "  timeout_seconds: 0",
    ].join("\n"),
    /\/ai\/timeout_seconds must be >= 1/,
  );
});

test("requires deterministic tool commands to be non-empty argv arrays", async () => {
  await assertFixtureValidationError(
    "invalid-string-command.yml",
    /\/tools\/0\/command must be array/,
  );
  assertValidationError(
    'version: 2\nai:\n  mode: off\ntools:\n  - name: eslint\n    command: ["npx", ""]\n',
    /\/tools\/0\/command\/1 must NOT have fewer than 1 characters/,
  );
});

test("rejects invalid deterministic tool execution settings", () => {
  assertValidationError(
    [
      "version: 2",
      "ai:",
      "  mode: off",
      "tools:",
      "  - name: eslint",
      '    command: ["npx", "eslint"]',
      "    timeout_seconds: 0",
    ].join("\n"),
    /\/tools\/0\/timeout_seconds must be >= 1/,
  );
  assertValidationError(
    [
      "version: 2",
      "ai:",
      "  mode: off",
      "tools:",
      "  - name: eslint",
      '    command: ["npx", "eslint"]',
      "    mode: advisory",
    ].join("\n"),
    /\/tools\/0\/mode must be equal to one of the allowed values/,
  );
  assertValidationError(
    [
      "version: 2",
      "ai:",
      "  mode: off",
      "tools:",
      "  - name: eslint",
      '    command: ["npx", "eslint"]',
      "    run: staged",
    ].join("\n"),
    /\/tools\/0\/run must be equal to one of the allowed values/,
  );
});

test("rejects invalid built-in policy settings", () => {
  assertValidationError(
    [
      "version: 2",
      "ai:",
      "  mode: off",
      "policies:",
      "  diff_size:",
      "    max_changed_lines: 0",
    ].join("\n"),
    /\/policies\/diff_size\/max_changed_lines must be >= 1/,
  );
  assertValidationError(
    [
      "version: 2",
      "ai:",
      "  mode: off",
      "policies:",
      "  forbidden_paths:",
      "    patterns: []",
    ].join("\n"),
    /\/policies\/forbidden_paths\/patterns must NOT have fewer than 1 items/,
  );
  assertValidationError(
    [
      "version: 2",
      "ai:",
      "  mode: off",
      "policies:",
      "  forbidden_paths:",
      "    patterns: [secrets/**]",
      "    mode: advisory",
    ].join("\n"),
    /\/policies\/forbidden_paths\/mode must be equal to one of the allowed values/,
  );
});

test("requires active AI modes to select a matching provider block", async () => {
  assertValidationError(
    "version: 2\nai:\n  providers:\n    claude: {}\n",
    /\.ai\.provider is required/,
  );
  await assertFixtureValidationError(
    "invalid-provider.yml",
    /\.ai\.providers\.copilot must be defined/,
  );
});

test("allows AI mode off without provider config", () => {
  const config = parseConfigYaml("version: 2\nai:\n  mode: off\n", "off.yml");

  assert.deepEqual(config.ai, {
    mode: "off",
    max_changed_lines: 500,
    max_prompt_tokens: 12_000,
    timeout_seconds: 120,
    providers: {},
  });
});

test("reports legacy-only repos with migration guidance", async () => {
  await withTempRepo(
    [[".push-review.yml", "review:\n  target_branch: main\n"]],
    async (repoRoot) => {
      await assert.rejects(loadConfig(repoRoot), (error) => {
        assert.ok(error instanceof LegacyConfigError);
        assert.match(error.message, /Migrate it to the v2 .pushgate.yml schema/);
        return true;
      });
    },
  );
});

test("prefers v2 config and warns when the legacy config also exists", async () => {
  await withTempRepo(
    [
      [".pushgate.yml", "version: 2\nai:\n  mode: off\n"],
      [".push-review.yml", "agent: {}\n"],
    ],
    async (repoRoot) => {
      const loaded = await loadConfig(repoRoot);

      assert.equal(loaded.config.ai.mode, "off");
      assert.equal(loaded.warnings.length, 1);
      assert.match(loaded.warnings[0], /Ignoring legacy .push-review.yml/);
    },
  );
});

test("reports a missing v2 config when neither config file exists", async () => {
  await withTempRepo([], async (repoRoot) => {
    await assert.rejects(loadConfig(repoRoot), (error) => {
      assert.ok(error instanceof MissingConfigError);
      assert.match(error.message, /No .pushgate.yml found/);
      return true;
    });
  });
});

test("keeps bundled templates on the v2 schema", async () => {
  const templateNames = [
    "base.yml",
    "nextjs.yml",
    "node.yml",
    "rails.yml",
    "ruby.yml",
    "typescript.yml",
  ];

  for (const templateName of templateNames) {
    const template = await readFile(new URL(templateName, templatesRoot), "utf8");
    assert.doesNotThrow(
      () => parseConfigYaml(template, `templates/${templateName}`),
      templateName,
    );
  }
});

async function parseFixture(name: string): Promise<PushgateConfig> {
  return parseConfigYaml(
    await readFile(new URL(name, fixtureRoot), "utf8"),
    `test/fixtures/config/${name}`,
  );
}

async function assertFixtureValidationError(
  name: string,
  messagePattern: RegExp,
): Promise<void> {
  assertValidationError(
    await readFile(new URL(name, fixtureRoot), "utf8"),
    messagePattern,
  );
}

function assertValidationError(yaml: string, messagePattern: RegExp): void {
  assert.throws(
    () => parseConfigYaml(yaml, "inline.yml"),
    (error) => {
      assert.ok(error instanceof ConfigValidationError);
      assert.match(error.message, messagePattern);
      return true;
    },
  );
}

async function withTempRepo(
  files: Array<[string, string]>,
  callback: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const repoRoot = await mkdtemp(join(tmpdir(), "pushgate-config-"));

  try {
    await Promise.all(
      files.map(([name, content]) => writeFile(join(repoRoot, name), content)),
    );
    return await callback(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

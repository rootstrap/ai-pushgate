import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanHookOutput,
  createHookHarness,
  type CommandResult,
  type HookHarness,
} from "./support/hook-harness.js";

test("runs deterministic tool and AI stubs for a passing hook invocation", async () => {
  await withHarness(async (harness) => {
    await harness.writeLegacyConfig(legacyConfig());
    await harness.installToolStub();
    await harness.installClaudeStub();

    const result = await harness.runHook();
    const output = cleanHookOutput(result);

    assert.equal(result.code, 0, output);
    assert.match(output, /AI review passed/);
    assert.deepEqual(await artifactLines(harness, "claude-args.txt"), ["--print"]);

    const toolArgs = await artifactLines(harness, "tool-args.txt");

    assert.ok(toolArgs.includes("src/changed.ts"));
    assert.ok(toolArgs.includes("src/deleted.ts"));
    assert.ok(toolArgs.includes("src/file with spaces.ts"));
    assert.ok(!toolArgs.includes("ignored/generated.ts"));

    const prompt = await requiredArtifact(harness, "claude-prompt.txt");

    assert.match(prompt, /src\/file with spaces\.ts/);
    assert.match(prompt, /src\/deleted\.ts/);
    assert.doesNotMatch(prompt, /ignored\/generated\.ts/);
  });
});

test("blocks before AI when a deterministic tool fails", async () => {
  await withHarness(async (harness) => {
    await harness.writeLegacyConfig(legacyConfig());
    await harness.installToolStub();
    await harness.installClaudeStub();

    const result = await harness.runHook({
      env: { PUSHGATE_TOOL_EXIT: "9" },
    });
    const output = cleanHookOutput(result);

    assert.equal(result.code, 1, output);
    assert.match(output, /Tool record-changes failed/);
    assert.equal(await harness.readArtifact("claude-args.txt"), null);
  });
});

test("blocks with a focused failure when a configured tool is missing", async () => {
  await withHarness(async (harness) => {
    await harness.writeLegacyConfig(
      legacyConfig({
        command: "missing-tool {changed_files}",
        name: "missing-tool",
      }),
    );
    await harness.installClaudeStub();

    const result = await harness.runHook();
    const output = cleanHookOutput(result);

    assert.equal(result.code, 1, output);
    assert.match(output, /Tool missing-tool failed/);
    assert.equal(await harness.readArtifact("claude-args.txt"), null);
  });
});

test("allows a push through after an AI warning result", async () => {
  await withHarness(async (harness) => {
    await harness.writeLegacyConfig(legacyConfig(null));
    await harness.installClaudeStub();

    const result = await harness.runHook({
      env: { PUSHGATE_CLAUDE_RESULT: "warning" },
    });
    const output = cleanHookOutput(result);

    assert.equal(result.code, 0, output);
    assert.match(output, /WARNING/);
    assert.match(output, /Blocking issues:\s+0/);
    assert.match(output, /Warnings:\s+1/);
  });
});

test("blocks after an AI blocking result", async () => {
  await withHarness(async (harness) => {
    await harness.writeLegacyConfig(legacyConfig(null));
    await harness.installClaudeStub();

    const result = await harness.runHook({
      env: { PUSHGATE_CLAUDE_RESULT: "block" },
    });
    const output = cleanHookOutput(result);

    assert.equal(result.code, 1, output);
    assert.match(output, /Blocking issues:\s+1/);
    assert.match(output, /Push blocked/);
  });
});

test("fails clearly when the current hook cannot find Claude", async () => {
  await withHarness(async (harness) => {
    await harness.writeLegacyConfig(legacyConfig(null));

    const result = await harness.runHook();
    const output = cleanHookOutput(result);

    assert.equal(result.code, 1, output);
    assert.match(output, /Claude Code CLI not found/);
    assert.match(output, /Cannot perform AI review/);
  });
});

test("characterizes the current provider failure fallback", async () => {
  await withHarness(async (harness) => {
    await harness.writeLegacyConfig(legacyConfig(null));
    await harness.installClaudeStub();

    const result = await harness.runHook({
      env: { PUSHGATE_CLAUDE_RESULT: "fail" },
    });
    const output = cleanHookOutput(result);

    assert.equal(result.code, 0, output);
    assert.match(output, /Claude exited with code 7/);
    assert.match(output, /allowing push to proceed/);
  });
});

test("proves git push --no-verify bypasses an installed pre-push hook", async () => {
  await withHarness(async (harness) => {
    await harness.writeLegacyConfig(legacyConfig());
    await harness.installToolStub();
    await harness.installClaudeStub();
    await harness.installInstalledHook();
    await harness.addBareOrigin();

    const result = await harness.git([
      "push",
      "--no-verify",
      "origin",
      "feature",
    ]);

    assert.equal(result.code, 0, formatResult(result));
    assert.equal(await harness.readArtifact("tool-args.txt"), null);
    assert.equal(await harness.readArtifact("claude-args.txt"), null);
  });
});

interface LegacyTool {
  command: string;
  name: string;
}

function legacyConfig(tool: LegacyTool | null = defaultLegacyTool): string {
  const lines = [
    "target_branch: main",
    "context_lines: 3",
    "max_lines_for_full_file: 1",
  ];

  if (tool) {
    lines.push(
      "tools:",
      `  - name: ${tool.name}`,
      `    command: ${tool.command}`,
      '    extensions: [".ts"]',
    );
  }

  lines.push("ignore_paths:", '  - "ignored/**"');

  return `${lines.join("\n")}\n`;
}

const defaultLegacyTool = {
  command: "record-tool {changed_files}",
  name: "record-changes",
};

async function withHarness(
  callback: (harness: HookHarness) => Promise<void>,
): Promise<void> {
  const harness = await createHookHarness();

  try {
    await callback(harness);
  } finally {
    await harness.cleanup();
  }
}

async function artifactLines(
  harness: HookHarness,
  name: string,
): Promise<string[]> {
  return (await requiredArtifact(harness, name)).trimEnd().split("\n");
}

async function requiredArtifact(
  harness: HookHarness,
  name: string,
): Promise<string> {
  const artifact = await harness.readArtifact(name);

  assert.ok(artifact !== null, `Expected stub artifact ${name}.`);
  return artifact;
}

function formatResult(result: CommandResult): string {
  return [
    `exit: ${String(result.code)}`,
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`,
  ].join("\n");
}

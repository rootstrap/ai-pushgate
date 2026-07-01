import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  cleanHookOutput,
  createHookHarness,
  type CommandResult,
  type HookHarness,
} from "./support/hook-harness.js";

test("forwards pre-push arguments and stdin to the managed runner", async () => {
  await withHarness(async (harness) => {
    await harness.installRunnerStub();

    const stdin =
      "refs/heads/feature 0123456789 refs/heads/feature fedcba9876\n";
    const result = await harness.runHook({
      args: ["origin", "git@example.test:rootstrap/ai-pushgate.git"],
      stdin,
    });

    assert.equal(result.code, 0, formatResult(result));
    assert.deepEqual(await artifactLines(harness, "runner-args.txt"), [
      "pre-push",
      "origin",
      "git@example.test:rootstrap/ai-pushgate.git",
    ]);
    assert.equal(await requiredArtifact(harness, "runner-stdin.txt"), stdin);
  });
});

test("returns the managed runner exit code", async () => {
  await withHarness(async (harness) => {
    await harness.installRunnerStub();

    const result = await harness.runHook({
      env: { PUSHGATE_RUNNER_EXIT: "9" },
      stdin: "",
    });

    assert.equal(result.code, 9, formatResult(result));
  });
});

test("uses PUSHGATE_RUNNER when provided", async () => {
  await withHarness(async (harness) => {
    const runnerPath = await writeOverrideRunner(
      harness,
      "env-override-runner",
      "env-override",
    );
    const stdin =
      "refs/heads/feature 0123456789 refs/heads/feature fedcba9876\n";
    const result = await harness.runHook({
      args: ["origin", "git@example.test:rootstrap/ai-pushgate.git"],
      env: { PUSHGATE_RUNNER: runnerPath, PUSHGATE_VERBOSE: "1" },
      stdin,
    });

    assert.equal(result.code, 0, formatResult(result));
    assert.match(
      cleanHookOutput(result),
      new RegExp(
        `Using runner from PUSHGATE_RUNNER: ${escapeRegex(runnerPath)}`,
      ),
    );
    assert.deepEqual(await artifactLines(harness, "env-override-args.txt"), [
      "pre-push",
      "origin",
      "git@example.test:rootstrap/ai-pushgate.git",
    ]);
    assert.equal(
      await requiredArtifact(harness, "env-override-stdin.txt"),
      stdin,
    );
  });
});

test("prefers git config pushgate.runner over PUSHGATE_RUNNER", async () => {
  await withHarness(async (harness) => {
    const configRunnerPath = await writeOverrideRunner(
      harness,
      "config-override-runner",
      "config-override",
    );
    const envRunnerPath = await writeOverrideRunner(
      harness,
      "env-override-runner",
      "env-override",
    );
    const configResult = await harness.git([
      "config",
      "--local",
      "pushgate.runner",
      configRunnerPath,
    ]);

    assert.equal(configResult.code, 0, formatResult(configResult));

    const result = await harness.runHook({
      env: { PUSHGATE_RUNNER: envRunnerPath },
      stdin: "",
    });

    assert.equal(result.code, 0, formatResult(result));
    assert.equal(await requiredArtifact(harness, "config-override-ran.txt"), "ran\n");
    assert.equal(await harness.readArtifact("env-override-ran.txt"), null);
  });
});

test("fails clearly when the managed runner is missing", async () => {
  await withHarness(async (harness) => {
    const result = await harness.runHook({ stdin: "" });
    const output = cleanHookOutput(result);

    assert.equal(result.code, 1, output);
    assert.match(output, /Pushgate runner from managed install not found/);
    assert.match(output, /Reinstall Pushgate/);
  });
});

test("reports how to unset a missing git-config runner override", async () => {
  await withHarness(async (harness) => {
    const configResult = await harness.git([
      "config",
      "--local",
      "pushgate.runner",
      join(harness.tempRoot, "missing-runner"),
    ]);

    assert.equal(configResult.code, 0, formatResult(configResult));

    const result = await harness.runHook({ stdin: "" });
    const output = cleanHookOutput(result);

    assert.equal(result.code, 1, output);
    assert.match(output, /Pushgate runner from git config pushgate\.runner not found/);
    assert.match(output, /git config --unset --local pushgate\.runner/);
  });
});

test("fails clearly when the managed runner is not executable", async () => {
  await withHarness(async (harness) => {
    await harness.installRunnerStub({ executable: false });

    const result = await harness.runHook({ stdin: "" });
    const output = cleanHookOutput(result);

    assert.equal(result.code, 1, output);
    assert.match(output, /is not executable/);
  });
});

test("fails clearly when the runner hook protocol is outdated", async () => {
  await withHarness(async (harness) => {
    await harness.installRunnerStub();

    const result = await harness.runHook({
      env: { PUSHGATE_RUNNER_PROTOCOL: "2" },
      stdin: "",
    });
    const output = cleanHookOutput(result);

    assert.equal(result.code, 1, output);
    assert.match(output, /uses hook protocol 2/);
    assert.match(output, /requires 1/);
  });
});

test("surfaces runner output when the protocol probe cannot execute", async () => {
  await withHarness(async (harness) => {
    await harness.installRunnerStub();

    const result = await harness.runHook({
      env: {
        PUSHGATE_RUNNER_PROTOCOL_ERROR: "env: node: No such file or directory",
        PUSHGATE_RUNNER_PROTOCOL_EXIT: "127",
      },
      stdin: "",
    });
    const output = cleanHookOutput(result);

    assert.equal(result.code, 1, output);
    assert.match(output, /could not report its hook protocol/);
    assert.match(output, /env: node: No such file or directory/);
  });
});

test("uses git config pushgate.runner during a real installed-hook push", async () => {
  await withHarness(async (harness) => {
    const runnerPath = await writeOverrideRunner(
      harness,
      "config-override-runner",
      "config-override",
    );
    const configResult = await harness.git([
      "config",
      "--local",
      "pushgate.runner",
      runnerPath,
    ]);

    assert.equal(configResult.code, 0, formatResult(configResult));

    await harness.installInstalledHook();
    await harness.addBareOrigin();

    const result = await harness.git(["push", "origin", "feature"], {
      env: { PUSHGATE_VERBOSE: "1" },
    });
    const output = cleanHookOutput(result);

    assert.equal(result.code, 0, formatResult(result));
    assert.match(
      output,
      new RegExp(
        `Using runner from git config pushgate\\.runner: ${escapeRegex(
          runnerPath,
        )}`,
      ),
    );
    assert.equal(await requiredArtifact(harness, "config-override-ran.txt"), "ran\n");
  });
});

test("allows a real installed-hook push through the boundary runner", async () => {
  await withHarness(async (harness) => {
    await harness.installRealRunner();
    await harness.installInstalledHook();
    await writePushgateConfig(harness, "version: 2\nai:\n  mode: off\ntools: []\n");
    await harness.addBareOrigin();

    const result = await harness.git(["push", "origin", "feature"]);

    assert.equal(result.code, 0, formatResult(result));
  });
});

test("blocks a real installed-hook push on deterministic command failure", async () => {
  await withHarness(async (harness) => {
    const failingTool = join(harness.binDir, "failing-tool");

    await writeFile(
      failingTool,
      "#!/usr/bin/env bash\nprintf 'tool failed\\n' >&2\nexit 3\n",
    );
    await chmod(failingTool, 0o755);
    await writePushgateConfig(
      harness,
      [
        "version: 2",
        "ai:",
        "  mode: off",
        "tools:",
        "  - name: failing",
        '    command: ["failing-tool"]',
      ].join("\n"),
    );
    await harness.installRealRunner();
    await harness.installInstalledHook();
    await harness.addBareOrigin();

    const result = await harness.git(["push", "origin", "feature"]);
    const output = cleanHookOutput(result);

    assert.equal(result.code, 1, output);
    assert.match(output, /\[block\] Failing\s+exited with code 3/);
    assert.match(output, /tool failed/);
  });
});

test("skip-all-checks bypasses config loading on a real installed-hook push", async () => {
  await withHarness(async (harness) => {
    await harness.installRealRunner();
    await harness.installInstalledHook();
    await harness.addBareOrigin();

    const result = await harness.git([
      "-c",
      "pushgate.skip-all-checks=true",
      "push",
      "origin",
      "feature",
    ]);
    const output = cleanHookOutput(result);

    assert.equal(result.code, 0, output);
    assert.match(
      output,
      /Skipping all local Pushgate checks because pushgate\.skip-all-checks=true/,
    );
  });
});

test("skip-ai-check keeps deterministic checks running on a real installed-hook push", async () => {
  await withHarness(async (harness) => {
    const markerPath = join(harness.artifactsDir, "tool-ran.txt");
    const recordingTool = join(harness.binDir, "recording-tool");

    await writeFile(
      recordingTool,
      `#!/usr/bin/env bash\nset -eu\nprintf 'ran\\n' > ${JSON.stringify(markerPath)}\n`,
    );
    await chmod(recordingTool, 0o755);
    await writePushgateConfig(
      harness,
      [
        "version: 2",
        "ai:",
        "  mode: blocking",
        "  provider: claude",
        "  providers:",
        "    claude: {}",
        "tools:",
        "  - name: record-tool",
        '    command: ["recording-tool"]',
        "    run: always",
      ].join("\n"),
    );
    await harness.installRealRunner();
    await harness.installInstalledHook();
    await harness.addBareOrigin();

    const result = await harness.git([
      "-c",
      "pushgate.skip-ai-check=true",
      "push",
      "origin",
      "feature",
    ]);
    const output = cleanHookOutput(result);

    assert.equal(result.code, 0, output);
    assert.equal(await requiredArtifact(harness, "tool-ran.txt"), "ran\n");
    assert.match(output, /\[ok\] Record tool/);
    assert.match(
      output,
      /Local AI Review\s+skipped because pushgate\.skip-ai-check=true/,
    );
  });
});

test("invokes the Claude adapter on a real installed-hook push", async () => {
  await withHarness(async (harness) => {
    const promptPath = join(harness.artifactsDir, "claude-prompt.txt");
    const claudeStub = join(harness.binDir, "claude");

    await writeFile(
      claudeStub,
      [
        "#!/usr/bin/env bash",
        "set -eu",
        "cat > \"$PUSHGATE_CLAUDE_PROMPT_OUT\"",
        "cat <<'EOF'",
        claudeStructuredOutputJson({
          schema_version: 1,
          findings: [],
        }),
        "EOF",
      ].join("\n"),
    );
    await chmod(claudeStub, 0o755);
    await writePushgateConfig(
      harness,
      [
        "version: 2",
        "ai:",
        "  mode: blocking",
        "  provider: claude",
        "  providers:",
        "    claude:",
        "      model: claude-sonnet-4-20250514",
        "tools: []",
      ].join("\n"),
    );
    await harness.installRealRunner();
    await harness.installInstalledHook();
    await harness.addBareOrigin();

    const result = await harness.git(["push", "origin", "feature"], {
      env: {
        PUSHGATE_CLAUDE_PROMPT_OUT: promptPath,
      },
    });
    const output = cleanHookOutput(result);

    assert.equal(result.code, 0, output);
    assert.match(output, /Provider: Claude/);
    assert.match(output, /\[ok\] No findings/);
    assert.match(await requiredArtifact(harness, "claude-prompt.txt"), /=== DIFF ===/);
    assert.match(await requiredArtifact(harness, "claude-prompt.txt"), /"schema_version": 1/);
  });
});

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

function claudeStructuredOutputJson(structuredOutput: unknown): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    structured_output: structuredOutput,
  });
}

async function requiredArtifact(
  harness: HookHarness,
  name: string,
): Promise<string> {
  const artifact = await harness.readArtifact(name);

  assert.ok(artifact !== null, `Expected runner artifact ${name}.`);
  return artifact;
}

function formatResult(result: CommandResult): string {
  return [
    `exit: ${String(result.code)}`,
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`,
  ].join("\n");
}

async function writePushgateConfig(
  harness: HookHarness,
  content: string,
): Promise<void> {
  await writeFile(join(harness.repoRoot, ".pushgate.yml"), `${content.trimEnd()}\n`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function writeOverrideRunner(
  harness: HookHarness,
  fileName: string,
  artifactPrefix: string,
): Promise<string> {
  const runnerPath = join(harness.tempRoot, fileName);
  const ranPath = join(harness.artifactsDir, `${artifactPrefix}-ran.txt`);
  const argsPath = join(harness.artifactsDir, `${artifactPrefix}-args.txt`);
  const stdinPath = join(harness.artifactsDir, `${artifactPrefix}-stdin.txt`);

  await writeFile(
    runnerPath,
    [
      "#!/usr/bin/env bash",
      "set -eu",
      'case "${1:-}" in',
      "  hook-protocol)",
      "    printf '1\\n'",
      "    ;;",
      "  pre-push)",
      `    printf 'ran\\n' > ${JSON.stringify(ranPath)}`,
      `    printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}`,
      `    cat > ${JSON.stringify(stdinPath)}`,
      "    ;;",
      "  *)",
      "    exit 64",
      "    ;;",
      "esac",
    ].join("\n"),
  );
  await chmod(runnerPath, 0o755);

  return runnerPath;
}

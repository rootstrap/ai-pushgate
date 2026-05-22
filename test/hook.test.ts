import assert from "node:assert/strict";
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

test("fails clearly when the managed runner is missing", async () => {
  await withHarness(async (harness) => {
    const result = await harness.runHook({ stdin: "" });
    const output = cleanHookOutput(result);

    assert.equal(result.code, 1, output);
    assert.match(output, /Pushgate runner not found/);
    assert.match(output, /Reinstall Pushgate/);
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

test("allows a real installed-hook push through the boundary runner", async () => {
  await withHarness(async (harness) => {
    await harness.installRealRunner();
    await harness.installInstalledHook();
    await harness.addBareOrigin();

    const result = await harness.git(["push", "origin", "feature"]);

    assert.equal(result.code, 0, formatResult(result));
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

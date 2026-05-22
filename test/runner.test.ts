import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runnerSourcePath = fileURLToPath(
  new URL("../bin/pushgate.mjs", import.meta.url),
);

test("prints the hook protocol for thin hook compatibility checks", async () => {
  const result = await runRunner(["hook-protocol"]);

  assert.equal(result.code, 0, formatResult(result));
  assert.equal(result.stdout, "1\n");
  assert.equal(result.stderr, "");
});

test("accepts pre-push args and drains Git hook stdin", async () => {
  const result = await runRunner(
    ["pre-push", "origin", "git@example.test:rootstrap/ai-pushgate.git"],
    "refs/heads/feature local refs/heads/feature remote\n",
  );

  assert.equal(result.code, 0, formatResult(result));
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("fails unsupported command shapes with usage output", async () => {
  const result = await runRunner(["hook-protocol", "extra"]);

  assert.equal(result.code, 64, formatResult(result));
  assert.match(result.stderr, /hook-protocol does not accept arguments/);
  assert.match(result.stderr, /Usage:/);
});

test("fails unsupported subcommands with usage output", async () => {
  const result = await runRunner(["review"]);

  assert.equal(result.code, 64, formatResult(result));
  assert.match(result.stderr, /Unsupported Pushgate command: review/);
  assert.match(result.stderr, /Usage:/);
});

interface RunnerResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

function runRunner(args: string[], stdin?: string): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerSourcePath, ...args], {
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";

    if (!child.stdout || !child.stderr) {
      reject(new Error("Runner tests must capture stdout and stderr."));
      return;
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      stdout += data;
    });
    child.stderr.on("data", (data: string) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stderr, stdout });
    });

    if (stdin !== undefined) {
      if (!child.stdin) {
        reject(new Error("Runner stdin was not piped."));
        return;
      }

      child.stdin.end(stdin);
    }
  });
}

function formatResult(result: RunnerResult): string {
  return [
    `exit: ${String(result.code)}`,
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`,
  ].join("\n");
}

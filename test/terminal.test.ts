import assert from "node:assert/strict";
import { closeSync, openSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createInteractiveTerminal,
  type InteractiveTerminal,
} from "../src/workflows/terminal.js";

test("interactive terminal accepts yes and no answers with empty input defaulting to no", async () => {
  const results: boolean[] = [];

  const output = await withTerminalInput("y\nyes\nn\nno\n\n", (terminal) => {
    results.push(
      terminal.confirm("Continue with push?"),
      terminal.confirm("Continue with push?"),
      terminal.confirm("Continue with push?"),
      terminal.confirm("Continue with push?"),
      terminal.confirm("Continue with push?"),
    );
  });

  assert.deepEqual(results, [true, true, false, false, false]);
  assert.equal(output, "Continue with push? [y/N] ".repeat(5));
});

test("interactive terminal re-prompts after an invalid answer", async () => {
  const output = await withTerminalInput("siu\ny\n", (terminal) => {
    assert.equal(terminal.confirm("Continue with push?"), true);
  });

  assert.equal(
    output,
    [
      "Continue with push? [y/N] ",
      "Please answer `y` or `n`.\n",
      "Continue with push? [y/N] ",
    ].join(""),
  );
});

test("interactive terminal consumes CRLF as one line ending", async () => {
  const output = await withTerminalInput("y\r\nn\r\n", (terminal) => {
    assert.equal(terminal.confirm("Continue with push?"), true);
    assert.equal(terminal.confirm("Continue with push?"), false);
  });

  assert.equal(output, "Continue with push? [y/N] ".repeat(2));
});

test("interactive terminal choice prompt supports arrow-key navigation", async () => {
  let selected = -1;
  const output = await withTerminalInput("\x1B[B\x1B[B\x1B[A\r", (terminal) => {
    selected = terminal.choose?.("Choose review target", [
      { label: "main", detail: "configured review.target_branch" },
      { label: "origin/main", detail: "latest fetched target remote" },
      { label: "Enter another ref", detail: "advanced" },
    ]) ?? -1;
  });

  assert.equal(selected, 1);
  assert.match(output, /> 2\. origin\/main - latest fetched target remote/);
});

test("interactive terminal choice prompt still accepts numeric selection", async () => {
  let selected = -1;

  await withTerminalInput("3\n", (terminal) => {
    selected = terminal.choose?.("Choose review target", [
      { label: "main" },
      { label: "origin/main" },
      { label: "Enter another ref" },
    ]) ?? -1;
  });

  assert.equal(selected, 2);
});

async function withTempDir<T>(
  callback: (tempDir: string) => Promise<T>,
): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), "pushgate-terminal-"));

  try {
    return await callback(tempDir);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

async function withTerminalInput(
  input: string,
  callback: (terminal: InteractiveTerminal) => void,
): Promise<string> {
  return await withTempDir(async (tempDir) => {
    const inputPath = join(tempDir, "input.txt");
    const outputPath = join(tempDir, "output.txt");

    await writeFile(inputPath, input);

    const inputFd = openSync(inputPath, "r");
    const outputFd = openSync(outputPath, "w");

    try {
      withAttachedTerminal(inputFd, outputFd, () => {
        callback(createInteractiveTerminal());
      });
    } finally {
      closeSync(inputFd);
      closeSync(outputFd);
    }

    return readFileSync(outputPath, "utf8");
  });
}

function withAttachedTerminal(
  inputFd: number,
  outputFd: number,
  callback: () => void,
): void {
  const previousInputIsTty = Object.getOwnPropertyDescriptor(
    process.stdin,
    "isTTY",
  );
  const previousInputFd = Object.getOwnPropertyDescriptor(process.stdin, "fd");
  const previousOutputIsTty = Object.getOwnPropertyDescriptor(
    process.stdout,
    "isTTY",
  );
  const previousOutputFd = Object.getOwnPropertyDescriptor(process.stdout, "fd");

  try {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdin, "fd", {
      configurable: true,
      value: inputFd,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "fd", {
      configurable: true,
      value: outputFd,
    });

    callback();
  } finally {
    restoreProperty(process.stdin, "isTTY", previousInputIsTty);
    restoreProperty(process.stdin, "fd", previousInputFd);
    restoreProperty(process.stdout, "isTTY", previousOutputIsTty);
    restoreProperty(process.stdout, "fd", previousOutputFd);
  }
}

function restoreProperty(
  target: object,
  property: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
    return;
  }

  delete (target as Record<string, unknown>)[property];
}

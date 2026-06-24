import assert from "node:assert/strict";
import { closeSync, openSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createInteractiveTerminal } from "../src/workflows/terminal.js";

test("interactive terminal consumes CRLF as one line ending", async () => {
  await withTempDir(async (tempDir) => {
    const inputPath = join(tempDir, "input.txt");
    const outputPath = join(tempDir, "output.txt");

    await writeFile(inputPath, "y\r\nn\r\n");

    const inputFd = openSync(inputPath, "r");
    const outputFd = openSync(outputPath, "w");

    try {
      await withAttachedTerminal(inputFd, outputFd, () => {
        const terminal = createInteractiveTerminal();

        assert.equal(terminal.confirm("[pushgate] First?"), true);
        assert.equal(terminal.confirm("[pushgate] Second?"), false);
      });
    } finally {
      closeSync(inputFd);
      closeSync(outputFd);
    }

    assert.equal(
      readFileSync(outputPath, "utf8"),
      [
        "[pushgate] First? yes(y) / no(n) ",
        "[pushgate] Second? yes(y) / no(n) ",
      ].join(""),
    );
  });
});

async function withTempDir(
  callback: (tempDir: string) => Promise<void>,
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "pushgate-terminal-"));

  try {
    await callback(tempDir);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
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

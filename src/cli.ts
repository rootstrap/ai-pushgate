import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { writePushgateError } from "./cli/errors.js";
import { parsePushCommandArgs } from "./cli/push-args.js";
import { runGitPush } from "./git/push.js";
import {
  buildGitPushArgs,
  SkipControlError,
} from "./skip-controls.js";
import {
  runPrePushWorkflow,
  type PrePushWorkflowIO,
} from "./workflows/pre-push.js";

const HOOK_PROTOCOL = "1";
const USAGE = `Usage:
  pushgate hook-protocol
  pushgate pre-push [git-hook-args...]
  pushgate push [--skip-all-checks] [--skip-ai-check] [git-push-args...]`;

interface CliIO extends PrePushWorkflowIO {}

export async function main(
  argv: string[] = process.argv.slice(2),
  io: CliIO = {
    env: process.env,
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
  },
): Promise<number> {
  const [command, ...args] = argv;

  switch (command) {
    case "hook-protocol":
      if (args.length > 0) {
        writeUsageError(
          io.stderr,
          `hook-protocol does not accept arguments: ${args.join(" ")}`,
        );
        return 64;
      }

      io.stdout.write(`${HOOK_PROTOCOL}\n`);
      return 0;
    case "pre-push":
      return runPrePushCommand(io);
    case "push":
      return runPushCommand(args, io);
    default:
      writeUsageError(
        io.stderr,
        command ? `Unsupported Pushgate command: ${command}` : "Missing Pushgate command.",
      );
      return 64;
  }
}

async function runPrePushCommand(io: CliIO): Promise<number> {
  try {
    return await runPrePushWorkflow(io);
  } catch (error) {
    writePushgateError(io.stderr, error);
    return 1;
  }
}

async function runPushCommand(
  args: readonly string[],
  io: CliIO,
): Promise<number> {
  try {
    const parsed = parsePushCommandArgs(args);

    const result = await runGitPush(
      buildGitPushArgs(parsed.gitPushArgs, parsed.skipControls),
      { env: io.env },
    ).catch((error: unknown) => {
      const spawnError = error as NodeJS.ErrnoException;

      throw new SkipControlError(
        spawnError.code === "ENOENT"
          ? "Git is required for `pushgate push`, but it was not found on PATH."
          : `Failed to run git push: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    if (result.code !== null) {
      return result.code;
    }

    throw new SkipControlError(
      `git push ended unexpectedly with signal ${result.signal ?? "unknown"}.`,
    );
  } catch (error) {
    writePushgateError(io.stderr, error);
    return 1;
  }
}

function writeUsageError(
  stderr: NodeJS.WritableStream,
  message: string,
): void {
  stderr.write(`${message}\n\n${USAGE}\n`);
}

if (isCliEntrypoint()) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

function isCliEntrypoint(): boolean {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
}

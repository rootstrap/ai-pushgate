import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ConfigError } from "./config/index.js";
import { ChangedFilePolicyError } from "./path-policy/index.js";
import { SkipControlError } from "./skip-controls.js";
import {
  runPrePushWorkflow,
  type PrePushWorkflowIO,
} from "./workflows/pre-push.js";

const HOOK_PROTOCOL = "1";
const USAGE = `Usage:
  pushgate hook-protocol
  pushgate pre-push [git-hook-args...]`;

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
      return runPrePushCommand(args, io);
    default:
      writeUsageError(
        io.stderr,
        command ? `Unsupported Pushgate command: ${command}` : "Missing Pushgate command.",
      );
      return 64;
  }
}

async function runPrePushCommand(
  args: readonly string[],
  io: CliIO,
): Promise<number> {
  try {
    return await runPrePushWorkflow({ ...io, hookArgs: args });
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

function writePushgateError(
  stderr: NodeJS.WritableStream,
  error: unknown,
): void {
  if (
    error instanceof ConfigError ||
    error instanceof ChangedFilePolicyError ||
    error instanceof SkipControlError
  ) {
    stderr.write(`[pushgate] ${error.message}\n`);
    return;
  }

  const detail = error instanceof Error ? error.message : String(error);

  stderr.write(`[pushgate] Unexpected Pushgate failure: ${detail}\n`);
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

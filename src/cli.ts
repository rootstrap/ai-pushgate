import { realpathSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { writePushgateError } from "./cli/errors.js";
import { parsePushCommandArgs } from "./cli/push-args.js";
import {
  parseGitPushArgs,
  resolveGitPushSuccessSummary,
  runGitPush,
  writeGitPushSuccessSummary,
} from "./git/push.js";
import { SkipControlError, type SkipControlState } from "./skip-controls.js";
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
      return runPrePushCommand(args, io);
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

async function runPushCommand(
  args: readonly string[],
  io: CliIO,
): Promise<number> {
  try {
    const parsed = parsePushCommandArgs(args);
    const preflightExitCode = await runPrePushWorkflow({
      ...io,
      env: withSkipControlConfigOverlay(io.env, parsed.skipControls),
      hookArgs: hookArgsForPush(parsed.gitPushArgs),
      stdin: Readable.from(""),
    });

    if (preflightExitCode !== 0) {
      return preflightExitCode;
    }

    const result = await runGitPush(
      buildNoVerifyGitPushArgs(parsed.gitPushArgs),
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
      if (result.code === 0) {
        await writeResolvedGitPushSuccessSummary(parsed.gitPushArgs, io);
      }

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

function hookArgsForPush(gitPushArgs: readonly string[]): readonly string[] {
  const parsed = parseGitPushArgs(gitPushArgs);

  return parsed.remote ? [parsed.remote] : [];
}

function buildNoVerifyGitPushArgs(gitPushArgs: readonly string[]): string[] {
  return ["push", "--no-verify", ...withoutHookVerificationOptions(gitPushArgs)];
}

function withoutHookVerificationOptions(
  gitPushArgs: readonly string[],
): string[] {
  const normalized: string[] = [];
  let parseOptions = true;

  for (const arg of gitPushArgs) {
    if (parseOptions && arg === "--") {
      parseOptions = false;
      normalized.push(arg);
      continue;
    }

    if (parseOptions && (arg === "--verify" || arg === "--no-verify")) {
      continue;
    }

    normalized.push(arg);
  }

  return normalized;
}

function withSkipControlConfigOverlay(
  env: NodeJS.ProcessEnv,
  skipControls: SkipControlState,
): NodeJS.ProcessEnv {
  if (skipControls.active.kind === "none") {
    return env;
  }

  const count = parseGitConfigCount(env.GIT_CONFIG_COUNT);

  return {
    ...env,
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${String(count)}`]: skipControls.active.configKey,
    [`GIT_CONFIG_VALUE_${String(count)}`]: "true",
  };
}

function parseGitConfigCount(value: string | undefined): number {
  if (value === undefined) {
    return 0;
  }

  const count = Number(value);

  return Number.isInteger(count) && count >= 0 ? count : 0;
}

async function writeResolvedGitPushSuccessSummary(
  gitPushArgs: readonly string[],
  io: CliIO,
): Promise<void> {
  try {
    writeGitPushSuccessSummary(
      io.stdout,
      await resolveGitPushSuccessSummary(gitPushArgs, {
        env: io.env,
      }),
      { env: io.env },
    );
  } catch {
    // Post-push copy is best-effort; Git's completed push stays authoritative.
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

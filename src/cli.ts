import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runLocalAiReview } from "./ai/index.js";
import {
  ConfigError,
  loadConfig,
  type PushgateConfig,
} from "./config/index.js";
import { runGitPush } from "./git/push.js";
import { resolveGitRepositoryRoot } from "./git/repository.js";
import {
  ChangedFilePolicyError,
  resolveChangedFiles,
  type ChangedFileResolution,
} from "./path-policy/index.js";
import { runDeterministicChecks } from "./runner/deterministic.js";
import { countBuiltInPolicies } from "./runner/policies.js";
import {
  buildGitPushArgs,
  resolveSkipControlState,
  SkipControlError,
  type SkipControlState,
} from "./skip-controls.js";

const HOOK_PROTOCOL = "1";
const USAGE = `Usage:
  pushgate hook-protocol
  pushgate pre-push [git-hook-args...]
  pushgate push [--skip-all-checks] [--skip-ai-check] [git-push-args...]`;

interface CliIO {
  env: NodeJS.ProcessEnv;
  stderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
}

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
      return runPrePush(io);
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

async function runPrePush(io: CliIO): Promise<number> {
  try {
    await drainStdin(io.stdin);

    const repoRoot = await resolveGitRepositoryRoot(io.env);
    const skipControls = await resolveSkipControlState(repoRoot, io.env);

    if (skipControls.skipAllChecks) {
      io.stdout.write(
        "[pushgate] Skipping all local Pushgate checks because pushgate.skip-all-checks=true.\n",
      );
      return 0;
    }

    const loaded = await loadConfig(repoRoot);

    for (const warning of loaded.warnings) {
      io.stdout.write(`[pushgate] Warning: ${warning}\n`);
    }

    const changedFileResolution = await maybeResolveChangedFiles(
      loaded.config,
      {
        repoRoot,
        skipControls,
      },
    );

    const summary = await runDeterministicPhase(
      loaded.config,
      changedFileResolution,
      {
        env: io.env,
        repoRoot,
        stderr: io.stderr,
        stdout: io.stdout,
      },
    );

    if (summary.exitCode !== 0) {
      return summary.exitCode;
    }

    return await runLocalAiPhase(
      loaded.config,
      changedFileResolution,
      skipControls,
      {
        env: io.env,
        repoRoot,
        stdout: io.stdout,
      },
    );
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
      buildGitPushArgs(parsed.gitPushArgs, {
        skipAllChecks: parsed.skipAllChecks,
        skipAiCheck: parsed.skipAiCheck,
      }),
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

async function runDeterministicPhase(
  config: PushgateConfig,
  changedFileResolution: ChangedFileResolution | null,
  options: {
    env: NodeJS.ProcessEnv;
    repoRoot: string;
    stderr: NodeJS.WritableStream;
    stdout: NodeJS.WritableStream;
  },
) {
  if (
    config.tools.length === 0 &&
    countBuiltInPolicies(config.policies) === 0
  ) {
    return runDeterministicChecks(config, [], options);
  }

  return runDeterministicChecks(config, changedFileResolution?.files ?? [], options);
}

async function runLocalAiPhase(
  config: PushgateConfig,
  changedFileResolution: ChangedFileResolution | null,
  skipControls: SkipControlState,
  options: {
    env: NodeJS.ProcessEnv;
    repoRoot: string;
    stdout: NodeJS.WritableStream;
  },
): Promise<number> {
  if (config.ai.mode === "off") {
    return 0;
  }

  if (skipControls.skipAiCheck) {
    options.stdout.write(
      "[pushgate] Skipping local AI because pushgate.skip-ai-check=true.\n",
    );
    return 0;
  }

  if (changedFileResolution === null) {
    throw new Error(
      "Pushgate could not prepare changed files for the local AI phase.",
    );
  }

  return (
    await runLocalAiReview({
      aiConfig: config.ai,
      changedFileResolution,
      env: options.env,
      repoRoot: options.repoRoot,
      reviewConfig: config.review,
      stdout: options.stdout,
    })
  ).exitCode;
}

async function maybeResolveChangedFiles(
  config: PushgateConfig,
  options: {
    repoRoot: string;
    skipControls: SkipControlState;
  },
): Promise<ChangedFileResolution | null> {
  const deterministicCheckCount =
    config.tools.length + countBuiltInPolicies(config.policies);
  const shouldRunAi =
    config.ai.mode !== "off" && !options.skipControls.skipAiCheck;

  if (deterministicCheckCount === 0 && !shouldRunAi) {
    return null;
  }

  return await resolveChangedFiles({
    repoRoot: options.repoRoot,
    targetBranch: config.review.target_branch,
    ignorePaths: config.ignore_paths,
  });
}

function drainStdin(stdin: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((stdin as { isTTY?: boolean }).isTTY) {
      resolve();
      return;
    }

    stdin.on("error", reject);
    stdin.on("end", resolve);
    stdin.resume();
  });
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

function writeUsageError(
  stderr: NodeJS.WritableStream,
  message: string,
): void {
  stderr.write(`${message}\n\n${USAGE}\n`);
}

function parsePushCommandArgs(args: readonly string[]): {
  gitPushArgs: string[];
  skipAllChecks: boolean;
  skipAiCheck: boolean;
} {
  const gitPushArgs: string[] = [];
  let parsePushgateFlags = true;
  let skipAiCheck = false;
  let skipAllChecks = false;

  for (const arg of args) {
    if (parsePushgateFlags && arg === "--skip-all-checks") {
      skipAllChecks = true;
      continue;
    }

    if (parsePushgateFlags && arg === "--skip-ai-check") {
      skipAiCheck = true;
      continue;
    }

    if (arg === "--") {
      parsePushgateFlags = false;
    }

    gitPushArgs.push(arg);
  }

  return {
    gitPushArgs,
    skipAllChecks,
    skipAiCheck: skipAllChecks ? false : skipAiCheck,
  };
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

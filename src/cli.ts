import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ConfigError,
  loadConfig,
} from "./config/index.js";
import {
  ChangedFilePolicyError,
  resolveChangedFiles,
} from "./path-policy/index.js";
import { runDeterministicChecks } from "./runner/deterministic.js";

const HOOK_PROTOCOL = "1";
const USAGE = `Usage:
  pushgate hook-protocol
  pushgate pre-push [git-hook-args...]`;

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

    const repoRoot = await resolveRepoRoot(io.env);
    const loaded = await loadConfig(repoRoot);

    for (const warning of loaded.warnings) {
      io.stdout.write(`[pushgate] Warning: ${warning}\n`);
    }

    if (loaded.config.tools.length === 0) {
      const summary = await runDeterministicChecks(loaded.config, [], {
        env: io.env,
        repoRoot,
        stderr: io.stderr,
        stdout: io.stdout,
      });

      return summary.exitCode;
    }

    const changedFiles = await resolveChangedFiles({
      repoRoot,
      targetBranch: loaded.config.review.target_branch,
      ignorePaths: loaded.config.ignore_paths,
    });
    const summary = await runDeterministicChecks(
      loaded.config,
      changedFiles.files,
      {
        env: io.env,
        repoRoot,
        stderr: io.stderr,
        stdout: io.stdout,
      },
    );

    return summary.exitCode;
  } catch (error) {
    writePushgateError(io.stderr, error);
    return 1;
  }
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

function resolveRepoRoot(env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["rev-parse", "--show-toplevel"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (data: string) => {
      stdout += data;
    });
    child.stderr?.on("data", (data: string) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(
        new Error(
          `Pushgate must run inside a Git repository. git rev-parse exited with ${String(code)}.${stderr.trim() ? ` ${stderr.trim()}` : ""}`,
        ),
      );
    });
  });
}

function writePushgateError(
  stderr: NodeJS.WritableStream,
  error: unknown,
): void {
  if (error instanceof ConfigError || error instanceof ChangedFilePolicyError) {
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

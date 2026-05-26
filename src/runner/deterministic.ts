import { spawn } from "node:child_process";

import type { PushgateConfig, ToolConfig } from "../config/index.js";
import {
  selectToolChangedFilePaths,
  type ChangedFile,
} from "../path-policy/index.js";

export const CHANGED_FILES_TOKEN = "{changed_files}" as const;

export type ToolResultStatus = "passed" | "skipped" | "warning" | "blocked";

export interface ToolResult {
  name: string;
  status: ToolResultStatus;
  detail?: string;
  outputTail?: string;
}

export interface DeterministicCheckSummary {
  exitCode: number;
  results: ToolResult[];
}

export interface DeterministicCheckOptions {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  stderr?: NodeJS.WritableStream;
  stdout?: NodeJS.WritableStream;
}

interface ToolCommandResult {
  passed: boolean;
  detail?: string;
  outputTail?: string;
}

const OUTPUT_CAPTURE_LIMIT = 64 * 1024;
const OUTPUT_TAIL_LIMIT = 4 * 1024;
const TIMEOUT_KILL_GRACE_MS = 1_000;

export async function runDeterministicChecks(
  config: PushgateConfig,
  changedFiles: readonly ChangedFile[],
  options: DeterministicCheckOptions = {},
): Promise<DeterministicCheckSummary> {
  const stdout = options.stdout ?? process.stdout;
  const repoRoot = options.repoRoot ?? process.cwd();
  const env = options.env ?? process.env;
  const results: ToolResult[] = [];

  if (config.tools.length === 0) {
    writeLine(stdout, "[pushgate] No deterministic checks configured.");
    return { exitCode: 0, results };
  }

  writeLine(
    stdout,
    `[pushgate] Running ${String(config.tools.length)} deterministic check(s).`,
  );

  for (const tool of config.tools) {
    const selectedPaths = selectToolChangedFilePaths(
      changedFiles,
      tool.extensions,
    );

    if (tool.run === "changed_files" && selectedPaths.length === 0) {
      const result: ToolResult = {
        name: tool.name,
        status: "skipped",
        detail: "no matching changed files",
      };

      results.push(result);
      writeLine(stdout, `[pushgate] SKIP ${tool.name}: ${result.detail}.`);
      continue;
    }

    const command = expandChangedFilesToken(tool.command, selectedPaths);
    const commandResult = await runToolCommand(tool, command, repoRoot, env);

    if (commandResult.passed) {
      results.push({ name: tool.name, status: "passed" });
      writeLine(stdout, `[pushgate] PASS ${tool.name}.`);
      continue;
    }

    const status: ToolResultStatus =
      tool.mode === "warning" ? "warning" : "blocked";
    const result: ToolResult = {
      name: tool.name,
      status,
      detail: commandResult.detail,
      outputTail: commandResult.outputTail,
    };

    results.push(result);
    writeFailure(stdout, tool, result);

    if (status === "blocked" && tool.fail_fast) {
      writeLine(
        stdout,
        "[pushgate] Stopping deterministic checks after blocking failure because fail_fast is true.",
      );
      break;
    }
  }

  const blockedCount = results.filter((result) => result.status === "blocked")
    .length;
  const warningCount = results.filter((result) => result.status === "warning")
    .length;

  writeLine(
    stdout,
    `[pushgate] Deterministic checks finished: ${String(blockedCount)} blocking failure(s), ${String(warningCount)} warning(s).`,
  );

  if (blockedCount > 0) {
    writeLine(
      stdout,
      "[pushgate] Fix the blocking command failures before pushing, or use git push --no-verify to bypass local hooks intentionally.",
    );
  }

  return { exitCode: blockedCount > 0 ? 1 : 0, results };
}

export function expandChangedFilesToken(
  command: readonly string[],
  changedFilePaths: readonly string[],
): string[] {
  return command.flatMap((token) =>
    token === CHANGED_FILES_TOKEN ? [...changedFilePaths] : [token],
  );
}

async function runToolCommand(
  tool: ToolConfig,
  command: readonly string[],
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<ToolCommandResult> {
  const [executable, ...args] = command;

  if (!executable) {
    return {
      passed: false,
      detail: "command was empty",
    };
  }

  return new Promise<ToolCommandResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const child = spawn(executable, args, {
      cwd: repoRoot,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (result: ToolCommandResult) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }

      if (killTimer) {
        clearTimeout(killTimer);
      }

      resolve(result);
    };

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, TIMEOUT_KILL_GRACE_MS);
    }, tool.timeout_seconds * 1_000);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (data: string) => {
      stdout = appendCapped(stdout, data);
    });
    child.stderr?.on("data", (data: string) => {
      stderr = appendCapped(stderr, data);
    });
    child.on("error", (error) => {
      finish({
        passed: false,
        detail: `failed to start: ${error.message}`,
        outputTail: formatOutputTail(stdout, stderr),
      });
    });
    child.on("close", (code, signal) => {
      if (timedOut) {
        finish({
          passed: false,
          detail: `timed out after ${String(tool.timeout_seconds)}s`,
          outputTail: formatOutputTail(stdout, stderr),
        });
        return;
      }

      if (code === 0) {
        finish({ passed: true });
        return;
      }

      finish({
        passed: false,
        detail:
          code === null
            ? `ended by signal ${signal ?? "unknown"}`
            : `exited with code ${String(code)}`,
        outputTail: formatOutputTail(stdout, stderr),
      });
    });
  });
}

function writeFailure(
  stdout: NodeJS.WritableStream,
  tool: ToolConfig,
  result: ToolResult,
): void {
  const label = result.status === "warning" ? "WARN" : "BLOCK";

  writeLine(
    stdout,
    `[pushgate] ${label} ${tool.name}: ${result.detail ?? "command failed"}.`,
  );

  if (result.outputTail) {
    writeLine(stdout, "[pushgate] Command output:");

    for (const line of result.outputTail.split("\n")) {
      writeLine(stdout, `[pushgate]   ${line}`);
    }
  }
}

function appendCapped(current: string, next: string): string {
  const combined = current + next;

  if (combined.length <= OUTPUT_CAPTURE_LIMIT) {
    return combined;
  }

  return combined.slice(-OUTPUT_CAPTURE_LIMIT);
}

function formatOutputTail(stdout: string, stderr: string): string | undefined {
  const output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n");

  if (!output) {
    return undefined;
  }

  if (output.length <= OUTPUT_TAIL_LIMIT) {
    return output;
  }

  return output.slice(-OUTPUT_TAIL_LIMIT);
}

function writeLine(stream: NodeJS.WritableStream, line: string): void {
  stream.write(`${line}\n`);
}

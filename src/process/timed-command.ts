import { spawn } from "node:child_process";

import { appendCapped, formatOutputTail } from "./output.js";

const DEFAULT_OUTPUT_CAPTURE_LIMIT = 64 * 1024;
const DEFAULT_OUTPUT_TAIL_LIMIT = 4 * 1024;
const DEFAULT_KILL_GRACE_MS = 1_000;

export type TimedCommandResult =
  | {
      code: number | null;
      kind: "completed";
      outputTail?: string;
      signal: NodeJS.Signals | null;
      stderr: string;
      stdout: string;
    }
  | {
      error: Error;
      kind: "spawn-error";
      outputTail?: string;
    }
  | {
      kind: "timeout";
      outputTail?: string;
    };

export interface RunTimedCommandOptions {
  args: readonly string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  killGraceMs?: number;
  outputCaptureLimit?: number;
  outputTailLimit?: number;
  stdin?: string;
  timeoutSeconds: number;
}

export function runTimedCommand(
  options: RunTimedCommandOptions,
): Promise<TimedCommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const outputCaptureLimit =
      options.outputCaptureLimit ?? DEFAULT_OUTPUT_CAPTURE_LIMIT;
    const outputTailLimit = options.outputTailLimit ?? DEFAULT_OUTPUT_TAIL_LIMIT;
    const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    const capturedOutputTail = () =>
      formatOutputTail(stdout, stderr, outputTailLimit);
    const finish = (result: TimedCommandResult) => {
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
      }, killGraceMs);
    }, options.timeoutSeconds * 1_000);

    if (!child.stdout || !child.stderr) {
      finish({
        error: new Error(`${options.command} output streams were not captured.`),
        kind: "spawn-error",
        outputTail: capturedOutputTail(),
      });
      return;
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      stdout = appendCapped(stdout, data, outputCaptureLimit);
    });
    child.stderr.on("data", (data: string) => {
      stderr = appendCapped(stderr, data, outputCaptureLimit);
    });
    child.on("error", (error) => {
      finish({
        error,
        kind: "spawn-error",
        outputTail: capturedOutputTail(),
      });
    });
    child.on("close", (code, signal) => {
      if (timedOut) {
        finish({
          kind: "timeout",
          outputTail: capturedOutputTail(),
        });
        return;
      }

      finish({
        code,
        kind: "completed",
        outputTail: capturedOutputTail(),
        signal,
        stderr,
        stdout,
      });
    });

    if (options.stdin !== undefined) {
      if (!child.stdin) {
        finish({
          error: new Error(`${options.command} stdin was not piped.`),
          kind: "spawn-error",
          outputTail: capturedOutputTail(),
        });
        return;
      }

      child.stdin.on("error", () => {
        // A command can exit before stdin fully drains; close/error handlers
        // remain the source of truth for the command result.
      });
      child.stdin.end(options.stdin);
    }
  });
}

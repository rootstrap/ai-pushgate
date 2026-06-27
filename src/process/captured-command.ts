import { spawn } from "node:child_process";

import { appendCapped, formatOutputTail } from "./output.js";

export type CapturedCommandOutputEncoding = "buffer" | "utf8";

interface CapturedCommandBaseOptions {
  args?: readonly string[];
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  ignoreStdinErrors?: boolean;
  killGraceMs?: number;
  outputCaptureLimit?: number;
  outputTailLimit?: number;
  shell?: boolean;
  stdin?: Buffer | string;
  timeoutMs?: number;
}

type CapturedCommandOptions =
  | (CapturedCommandBaseOptions & { outputEncoding: "buffer" })
  | (CapturedCommandBaseOptions & { outputEncoding: "utf8" });

export type CapturedCommandResult<Stdout extends Buffer | string> =
  | {
      code: number | null;
      kind: "completed";
      outputTail?: string;
      signal: NodeJS.Signals | null;
      stderr: string;
      stdout: Stdout;
    }
  | {
      error: Error;
      kind: "spawn-error";
      outputTail?: string;
      stderr: string;
      stdout: Stdout;
    }
  | {
      kind: "timeout";
      outputTail?: string;
      stderr: string;
      stdout: Stdout;
    };

type AnyCapturedCommandResult =
  | CapturedCommandResult<Buffer>
  | CapturedCommandResult<string>;

export function runCapturedCommand(
  options: CapturedCommandBaseOptions & { outputEncoding: "buffer" },
): Promise<CapturedCommandResult<Buffer>>;
export function runCapturedCommand(
  options: CapturedCommandBaseOptions & { outputEncoding: "utf8" },
): Promise<CapturedCommandResult<string>>;
export function runCapturedCommand(
  options: CapturedCommandOptions,
): Promise<AnyCapturedCommandResult> {
  return new Promise<AnyCapturedCommandResult>((resolve) => {
    const outputEncoding = options.outputEncoding;
    const stdoutBuffers: Buffer[] = [];
    let stdout = "";
    let stderr = "";
    let exited = false;
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const useProcessGroup = shouldUseProcessGroup(options);

    const child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      detached: useProcessGroup,
      env: options.env,
      shell: options.shell,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    const capturedStdout = (): Buffer | string =>
      outputEncoding === "buffer" ? Buffer.concat(stdoutBuffers) : stdout;
    const capturedOutputTail = () =>
      outputEncoding === "utf8" && options.outputTailLimit !== undefined
        ? formatOutputTail(stdout, stderr, options.outputTailLimit)
        : undefined;
    const finish = (result: CapturedCommandResult<Buffer | string>) => {
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

      resolve(result as AnyCapturedCommandResult);
    };

    if (options.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        signalChild("SIGTERM");
        killTimer = setTimeout(() => {
          if (useProcessGroup || !exited) {
            signalChild("SIGKILL");
          }
        }, options.killGraceMs ?? 0);
      }, options.timeoutMs);
    }

    if (!child.stdout || !child.stderr) {
      finish({
        error: new Error(`${options.command} output streams were not captured.`),
        kind: "spawn-error",
        outputTail: capturedOutputTail(),
        stderr,
        stdout: capturedStdout(),
      });
      return;
    }

    if (outputEncoding === "buffer") {
      child.stdout.on("data", (data: Buffer) => {
        stdoutBuffers.push(data);
      });
    } else {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (data: string) => {
        stdout = appendCaptured(stdout, data, options.outputCaptureLimit);
      });
    }

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => {
      stderr = appendCaptured(stderr, data, options.outputCaptureLimit);
    });
    child.on("error", (error) => {
      finish({
        error,
        kind: "spawn-error",
        outputTail: capturedOutputTail(),
        stderr,
        stdout: capturedStdout(),
      });
    });
    child.on("exit", () => {
      exited = true;

      if (!useProcessGroup && killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
    });
    child.on("close", (code, signal) => {
      if (timedOut) {
        finish({
          kind: "timeout",
          outputTail: capturedOutputTail(),
          stderr,
          stdout: capturedStdout(),
        });
        return;
      }

      finish({
        code,
        kind: "completed",
        outputTail: capturedOutputTail(),
        signal,
        stderr,
        stdout: capturedStdout(),
      });
    });

    if (options.stdin !== undefined) {
      if (!child.stdin) {
        finish({
          error: new Error(`${options.command} stdin was not piped.`),
          kind: "spawn-error",
          outputTail: capturedOutputTail(),
          stderr,
          stdout: capturedStdout(),
        });
        return;
      }

      if (options.ignoreStdinErrors) {
        child.stdin.on("error", () => {
          // Close/error handlers remain the source of truth for the result.
        });
      }

      child.stdin.end(options.stdin);
    }

    function signalChild(signal: NodeJS.Signals): void {
      if (child.pid === undefined) {
        return;
      }

      try {
        if (useProcessGroup) {
          process.kill(-child.pid, signal);
          return;
        }

        child.kill(signal);
      } catch (error) {
        if (!isMissingProcessError(error)) {
          throw error;
        }
      }
    }
  });
}

function shouldUseProcessGroup(options: CapturedCommandOptions): boolean {
  return options.timeoutMs !== undefined && process.platform !== "win32";
}

function isMissingProcessError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ESRCH"
  );
}

function appendCaptured(
  current: string,
  next: string,
  outputCaptureLimit: number | undefined,
): string {
  return outputCaptureLimit === undefined
    ? current + next
    : appendCapped(current, next, outputCaptureLimit);
}

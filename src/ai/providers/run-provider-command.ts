import { spawn } from "node:child_process";

const DEFAULT_OUTPUT_CAPTURE_LIMIT = 128 * 1024;
const DEFAULT_OUTPUT_TAIL_LIMIT = 8 * 1024;

export type ProviderCommandResult =
  | {
      code: number | null;
      kind: "completed";
      output?: string;
      stdout: string;
    }
  | {
      kind: "spawn-error";
    }
  | {
      kind: "timeout";
      output?: string;
    };

export function runProviderCommand(options: {
  args: readonly string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  outputCaptureLimit?: number;
  outputTailLimit?: number;
  prompt: string;
  timeoutSeconds: number;
}): Promise<ProviderCommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const outputCaptureLimit =
      options.outputCaptureLimit ?? DEFAULT_OUTPUT_CAPTURE_LIMIT;
    const outputTailLimit = options.outputTailLimit ?? DEFAULT_OUTPUT_TAIL_LIMIT;
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const finish = (result: ProviderCommandResult) => {
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
      }, 1_000);
    }, options.timeoutSeconds * 1_000);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (data: string) => {
      stdout = appendCapped(stdout, data, outputCaptureLimit);
    });
    child.stderr?.on("data", (data: string) => {
      stderr = appendCapped(stderr, data, outputCaptureLimit);
    });
    child.on("error", () => {
      finish({ kind: "spawn-error" });
    });
    child.on("close", (code) => {
      if (timedOut) {
        finish({
          kind: "timeout",
          output: formatCombinedOutput(stdout, stderr, outputTailLimit),
        });
        return;
      }

      finish({
        code,
        kind: "completed",
        output: formatCombinedOutput(stdout, stderr, outputTailLimit),
        stdout,
      });
    });

    child.stdin?.on("error", () => {
      // Provider CLIs may exit before stdin fully drains; the close path still
      // reports the real provider result.
    });
    child.stdin?.end(options.prompt);
  });
}

function appendCapped(
  current: string,
  next: string,
  outputCaptureLimit: number,
): string {
  const combined = current + next;

  if (combined.length <= outputCaptureLimit) {
    return combined;
  }

  return combined.slice(-outputCaptureLimit);
}

function formatCombinedOutput(
  stdout: string,
  stderr: string,
  outputTailLimit: number,
): string | undefined {
  const combined = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n");

  if (combined.length === 0) {
    return undefined;
  }

  if (combined.length <= outputTailLimit) {
    return combined;
  }

  return combined.slice(-outputTailLimit);
}

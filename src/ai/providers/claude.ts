import { spawn } from "node:child_process";

import { AiReviewOutputError, parseAiReviewOutput } from "../review-output.js";
import type {
  LocalAiProviderAdapter,
  LocalAiProviderFailure,
  LocalAiProviderResult,
} from "../types.js";

const OUTPUT_CAPTURE_LIMIT = 128 * 1024;
const OUTPUT_TAIL_LIMIT = 8 * 1024;

export const claudeProvider: LocalAiProviderAdapter = {
  id: "claude",
  async runReview(options) {
    const model = selectClaudeModel(options.providerConfig);
    const args = buildClaudeArgs(options.repoRoot, model);
    const commandResult = await runClaudeCommand(
      args,
      options.payload.prompt,
      options.repoRoot,
      options.env,
      options.timeoutSeconds,
    );

    if (commandResult.kind === "spawn-error") {
      return {
        kind: "provider-error",
        code: "missing_binary",
        provider: "claude",
        message:
          "Claude Code CLI was not found on PATH. Install it before running Pushgate local AI review.",
      };
    }

    if (commandResult.kind === "timeout") {
      return {
        kind: "provider-error",
        code: "timed_out",
        provider: "claude",
        message: `Claude Code CLI timed out after ${String(options.timeoutSeconds)}s.`,
        output: commandResult.output,
      };
    }

    if (commandResult.code !== 0) {
      if (await isClaudeUnauthenticated(options.repoRoot, options.env)) {
        return {
          kind: "provider-error",
          code: "not_authenticated",
          provider: "claude",
          message:
            "Claude Code CLI is not authenticated. Run `claude auth login` before pushing again.",
          output: commandResult.output,
        };
      }

      return {
        kind: "provider-error",
        code: "command_failed",
        provider: "claude",
        message: `Claude Code CLI exited with code ${String(commandResult.code)}.`,
        output: commandResult.output,
      };
    }

    const rawOutput = commandResult.stdout.trim();

    if (rawOutput.length === 0) {
      return {
        kind: "provider-error",
        code: "empty_output",
        provider: "claude",
        message: "Claude Code CLI returned an empty review response.",
        output: commandResult.output,
      };
    }

    try {
      const parsed = parseAiReviewOutput(rawOutput, {
        provider: "claude",
        ...(model ? { model } : {}),
      });

      return {
        kind: "review",
        provider: "claude",
        findings: parsed.findings,
        normalizationNotes: parsed.normalizationNotes,
        rawOutput,
        summary: parsed.summary,
      };
    } catch (error) {
      const detail =
        error instanceof AiReviewOutputError
          ? error.diagnostics.join("\n") || error.message
          : String(error);

      return {
        kind: "provider-error",
        code: "invalid_output",
        provider: "claude",
        message: "Claude Code CLI returned malformed review output.",
        detail,
        output: commandResult.output,
      };
    }
  },
};

function buildClaudeArgs(repoRoot: string, model?: string): string[] {
  const args = [
    "-p",
    "Review the provided Pushgate review input exactly as instructed.",
    "--output-format",
    "text",
    "--bare",
    "--tools",
    "Read",
    "--allowedTools",
    "Read",
    "--permission-mode",
    "bypassPermissions",
    "--no-session-persistence",
    "--add-dir",
    repoRoot,
  ];

  if (model) {
    args.push("--model", model);
  }

  return args;
}

function selectClaudeModel(providerConfig: Record<string, unknown>): string | undefined {
  const model = providerConfig.model;

  return typeof model === "string" && model.trim().length > 0
    ? model.trim()
    : undefined;
}

function runClaudeCommand(
  args: readonly string[],
  prompt: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  timeoutSeconds: number,
): Promise<
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
    }
> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const child = spawn("claude", args, {
      cwd: repoRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const finish = (
      result:
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
          },
    ) => {
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
    }, timeoutSeconds * 1_000);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (data: string) => {
      stdout = appendCapped(stdout, data);
    });
    child.stderr?.on("data", (data: string) => {
      stderr = appendCapped(stderr, data);
    });
    child.on("error", () => {
      finish({ kind: "spawn-error" });
    });
    child.on("close", (code) => {
      if (timedOut) {
        finish({
          kind: "timeout",
          output: formatCombinedOutput(stdout, stderr),
        });
        return;
      }

      finish({
        code,
        kind: "completed",
        output: formatCombinedOutput(stdout, stderr),
        stdout,
      });
    });

    child.stdin?.on("error", () => {
      // Claude may exit before stdin fully drains; the process close path
      // still reports the real result.
    });
    child.stdin?.end(prompt);
  });
}

async function isClaudeUnauthenticated(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("claude", ["auth", "status"], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "ignore", "ignore"],
    });

    child.on("error", () => {
      resolve(false);
    });
    child.on("close", (code) => {
      resolve(code === 1);
    });
  });
}

function appendCapped(current: string, next: string): string {
  const combined = current + next;

  if (combined.length <= OUTPUT_CAPTURE_LIMIT) {
    return combined;
  }

  return combined.slice(-OUTPUT_CAPTURE_LIMIT);
}

function formatCombinedOutput(stdout: string, stderr: string): string | undefined {
  const combined = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n");

  if (combined.length === 0) {
    return undefined;
  }

  if (combined.length <= OUTPUT_TAIL_LIMIT) {
    return combined;
  }

  return combined.slice(-OUTPUT_TAIL_LIMIT);
}

import { spawn } from "node:child_process";

import { AiReviewOutputError, parseAiReviewOutput } from "../review-output.js";
import type {
  LocalAiProviderAdapter,
  LocalAiProviderFailure,
  LocalAiProviderResult,
} from "../types.js";

const OUTPUT_CAPTURE_LIMIT = 128 * 1024;
const OUTPUT_TAIL_LIMIT = 8 * 1024;

export const copilotProvider: LocalAiProviderAdapter = {
  id: "copilot",
  async runReview(options) {
    const model = selectCopilotModel(options.providerConfig);
    const args = buildCopilotArgs(model);
    const commandResult = await runCopilotCommand(
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
        provider: "copilot",
        message:
          "GitHub Copilot CLI was not found on PATH. Install the standalone `copilot` command before running Pushgate local AI review.",
      };
    }

    if (commandResult.kind === "timeout") {
      return {
        kind: "provider-error",
        code: "timed_out",
        provider: "copilot",
        message: `GitHub Copilot CLI timed out after ${String(options.timeoutSeconds)}s.`,
        output: commandResult.output,
      };
    }

    if (commandResult.code !== 0) {
      const output = commandResult.output ?? "";

      if (isCopilotAuthFailure(output)) {
        return {
          kind: "provider-error",
          code: "not_authenticated",
          provider: "copilot",
          message:
            "GitHub Copilot CLI is not authenticated or cannot access Copilot. Run `copilot login`, configure `COPILOT_GITHUB_TOKEN`, or verify your Copilot CLI organization policy.",
          output: commandResult.output,
        };
      }

      return {
        kind: "provider-error",
        code: "command_failed",
        provider: "copilot",
        message: `GitHub Copilot CLI exited with code ${String(commandResult.code)}.`,
        output: commandResult.output,
      };
    }

    const rawOutput = commandResult.stdout.trim();

    if (rawOutput.length === 0) {
      return {
        kind: "provider-error",
        code: "empty_output",
        provider: "copilot",
        message: "GitHub Copilot CLI returned an empty review response.",
        output: commandResult.output,
      };
    }

    try {
      const parsed = parseAiReviewOutput(rawOutput, {
        provider: "copilot",
        ...(model ? { model } : {}),
      });

      return {
        kind: "review",
        provider: "copilot",
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
        provider: "copilot",
        message: "GitHub Copilot CLI returned malformed review output.",
        detail,
        output: commandResult.output,
      };
    }
  },
};

function buildCopilotArgs(model?: string): string[] {
  const args = [
    "-s",
    "--no-ask-user",
    "--stream=off",
    "--output-format=text",
    "--no-color",
    "--no-custom-instructions",
    "--no-remote",
    "--disable-builtin-mcps",
    "--available-tools=view,grep,glob",
    "--allow-tool=read",
    "--deny-tool=shell",
    "--deny-tool=write",
    "--deny-tool=url",
  ];

  if (model) {
    args.push(`--model=${model}`);
  }

  return args;
}

function selectCopilotModel(
  providerConfig: Record<string, unknown>,
): string | undefined {
  const model = providerConfig.model;

  return typeof model === "string" && model.trim().length > 0
    ? model.trim()
    : undefined;
}

function runCopilotCommand(
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
    const child = spawn("copilot", args, {
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
      // Copilot may exit before stdin fully drains; the close path still
      // reports the real provider result.
    });
    child.stdin?.end(prompt);
  });
}

function isCopilotAuthFailure(output: string): boolean {
  return [
    /not authenticated/i,
    /authentication required/i,
    /must authenticate/i,
    /please authenticate/i,
    /not logged in/i,
    /copilot login/i,
    /\/login/i,
    /COPILOT_GITHUB_TOKEN/,
    /\bGH_TOKEN\b/,
    /\bGITHUB_TOKEN\b/,
    /copilot.*subscription/i,
    /copilot.*policy.*enabled/i,
    /access.*copilot/i,
  ].some((pattern) => pattern.test(output));
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

import { spawn } from "node:child_process";

import type { LocalAiProviderAdapter } from "../types.js";
import { selectProviderModel } from "./config.js";
import { normalizeProviderReviewOutput } from "./normalize-review.js";
import { runProviderCommand } from "./run-provider-command.js";

export const claudeProvider: LocalAiProviderAdapter = {
  id: "claude",
  async runReview(options) {
    const model = selectProviderModel(options.providerConfig);
    const args = buildClaudeArgs(options.repoRoot, model);
    const commandResult = await runProviderCommand({
      args,
      command: "claude",
      cwd: options.repoRoot,
      env: options.env,
      prompt: options.payload.prompt,
      timeoutSeconds: options.timeoutSeconds,
    });

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

    return normalizeProviderReviewOutput({
      emptyOutputMessage: "Claude Code CLI returned an empty review response.",
      invalidOutputMessage: "Claude Code CLI returned malformed review output.",
      model,
      output: commandResult.output,
      provider: "claude",
      stdout: commandResult.stdout,
    });
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

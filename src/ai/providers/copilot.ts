import type { LocalAiProviderAdapter } from "../types.js";
import { selectProviderModel } from "./config.js";
import { normalizeProviderReviewOutput } from "./normalize-review.js";
import { runProviderCommand } from "./run-provider-command.js";

export const copilotProvider: LocalAiProviderAdapter = {
  id: "copilot",
  async runReview(options) {
    const model = selectProviderModel(options.providerConfig);
    const args = buildCopilotArgs(model);
    const commandResult = await runProviderCommand({
      args,
      command: "copilot",
      cwd: options.repoRoot,
      env: options.env,
      prompt: options.payload.prompt,
      timeoutSeconds: options.timeoutSeconds,
    });

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

    return normalizeProviderReviewOutput({
      emptyOutputMessage: "GitHub Copilot CLI returned an empty review response.",
      invalidOutputMessage:
        "GitHub Copilot CLI returned malformed review output.",
      model,
      output: commandResult.output,
      provider: "copilot",
      stdout: commandResult.stdout,
    });
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

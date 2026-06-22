import type { PushgateConfig } from "../config/index.js";
import {
  selectToolChangedFilePaths,
  type ChangedFile,
  type ChangedFileResolution,
} from "../path-policy/index.js";
import {
  countBuiltInPolicies,
  runBuiltInPolicies,
} from "./policies.js";
import { runGitleaksPlugin } from "./plugins/gitleaks.js";
import { countPluginChecks } from "./plugins.js";
import { summarizeDeterministicResults } from "./summary.js";
import { createDeterministicTranscript } from "./transcript.js";
import { runToolCommand } from "./tool-command.js";

export {
  CHANGED_FILES_TOKEN,
  expandChangedFilesToken,
} from "./tool-command.js";

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
  changedFileResolution?: ChangedFileResolution;
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  stderr?: NodeJS.WritableStream;
  stdout?: NodeJS.WritableStream;
}

export async function runDeterministicChecks(
  config: PushgateConfig,
  changedFiles: readonly ChangedFile[],
  options: DeterministicCheckOptions = {},
): Promise<DeterministicCheckSummary> {
  const stdout = options.stdout ?? process.stdout;
  const repoRoot = options.repoRoot ?? process.cwd();
  const env = options.env ?? process.env;
  const results: ToolResult[] = [];
  const transcript = createDeterministicTranscript(stdout);
  const policyCount = countBuiltInPolicies(config.policies);
  const pluginCount = countPluginChecks(config.plugins);
  const checkCount = policyCount + pluginCount + config.tools.length;
  let stopAfterBlockingPlugin = false;

  if (checkCount === 0) {
    transcript.writeNoChecks();
    return { exitCode: 0, results };
  }

  transcript.writeStart(checkCount);

  for (const policyResult of runBuiltInPolicies(
    config.policies,
    changedFiles,
  )) {
    results.push(policyResult);
    transcript.writePolicyResult(policyResult);
  }

  if (config.plugins.gitleaks?.enabled) {
    const plugin = config.plugins.gitleaks;
    const name = "plugin:gitleaks";
    const commandResult = options.changedFileResolution
      ? await runGitleaksPlugin(
          plugin,
          options.changedFileResolution,
          repoRoot,
          env,
        )
      : {
          passed: false,
          detail: "requires resolved Git diff metadata",
        };

    if (commandResult.passed) {
      const result: ToolResult = { name, status: "passed" };

      results.push(result);
      transcript.writePluginResult(name, result);
    } else {
      const status: ToolResultStatus =
        plugin.mode === "warning" ? "warning" : "blocked";
      const result: ToolResult = {
        name,
        status,
        detail: commandResult.detail,
        outputTail: commandResult.outputTail,
      };

      results.push(result);
      transcript.writePluginResult(name, result);

      if (status === "blocked" && plugin.fail_fast) {
        transcript.writeFailFast();
        stopAfterBlockingPlugin = true;
      }
    }
  }

  if (stopAfterBlockingPlugin) {
    const resultSummary = summarizeDeterministicResults(results);

    transcript.writeSummary(resultSummary);
    return { exitCode: resultSummary.exitCode, results };
  }

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
      transcript.writeToolResult(tool, result);
      continue;
    }

    const commandResult = await runToolCommand(
      tool,
      selectedPaths,
      repoRoot,
      env,
    );

    if (commandResult.passed) {
      const result: ToolResult = { name: tool.name, status: "passed" };

      results.push(result);
      transcript.writeToolResult(tool, result);
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
    transcript.writeToolResult(tool, result);

    if (status === "blocked" && tool.fail_fast) {
      transcript.writeFailFast();
      break;
    }
  }

  const resultSummary = summarizeDeterministicResults(results);

  transcript.writeSummary(resultSummary);
  return { exitCode: resultSummary.exitCode, results };
}

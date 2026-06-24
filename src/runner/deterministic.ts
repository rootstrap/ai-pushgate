import type { PushgateConfig } from "../config/index.js";
import {
  selectToolChangedFilePaths,
  type ChangedFileResolution,
} from "../path-policy/index.js";
import {
  countBuiltInPolicies,
  runBuiltInPolicies,
} from "./policies.js";
import { runGitleaksPlugin } from "./plugins/gitleaks.js";
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

export interface DeterministicCheckPlan {
  checkCount: number;
  needsChangedFileResolution: boolean;
  runChecks: boolean;
}

export interface DeterministicCheckRequest {
  changedFileResolution?: ChangedFileResolution | null;
  config: PushgateConfig;
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  stdout?: NodeJS.WritableStream;
}

export function buildDeterministicCheckPlan(
  config: PushgateConfig,
): DeterministicCheckPlan {
  const checkCount =
    countBuiltInPolicies(config.policies) +
    countPluginChecks(config) +
    config.tools.length;

  return {
    checkCount,
    needsChangedFileResolution: checkCount > 0,
    runChecks: checkCount > 0,
  };
}

export async function runDeterministicChecks(
  request: DeterministicCheckRequest,
): Promise<DeterministicCheckSummary> {
  const { config } = request;
  const stdout = request.stdout ?? process.stdout;
  const repoRoot = request.repoRoot ?? process.cwd();
  const env = request.env ?? process.env;
  const results: ToolResult[] = [];
  const transcript = createDeterministicTranscript(stdout);
  const plan = buildDeterministicCheckPlan(config);
  let stopAfterBlockingPlugin = false;

  if (!plan.runChecks) {
    transcript.writeNoChecks();
    return { exitCode: 0, results };
  }

  const changedFileResolution = requireChangedFileResolution(
    request.changedFileResolution,
  );
  const changedFiles = changedFileResolution.files;

  transcript.writeStart(plan.checkCount);

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
    const commandResult = await runGitleaksPlugin(
      plugin,
      changedFileResolution,
      repoRoot,
      env,
    );

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

function countPluginChecks(config: PushgateConfig): number {
  return Number(Boolean(config.plugins.gitleaks?.enabled));
}

function requireChangedFileResolution(
  changedFileResolution: ChangedFileResolution | null | undefined,
): ChangedFileResolution {
  if (changedFileResolution) {
    return changedFileResolution;
  }

  throw new Error(
    "Pushgate could not prepare changed files for deterministic checks.",
  );
}

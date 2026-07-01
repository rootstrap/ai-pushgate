import type {
  BuiltInPoliciesConfig,
  GitleaksPluginConfig,
  PushgateConfig,
  ToolConfig,
} from "../config/index.js";
import {
  selectToolChangedFilePaths,
  type ChangedFileResolution,
} from "../path-policy/index.js";
import { humanizeIdentifier } from "../terminal/format.js";
import type { DeterministicTranscriptCheckResult } from "../transcript/index.js";
import type { ToolResult, ToolResultStatus } from "./deterministic.js";
import { runGitleaksPlugin } from "./plugins/gitleaks.js";
import { runBuiltInPolicies } from "./policies.js";
import { runToolCommand } from "./tool-command.js";

export interface DeterministicCheckExecutionContext {
  changedFileResolution: ChangedFileResolution;
  env: NodeJS.ProcessEnv;
  repoRoot: string;
}

export interface DeterministicCheckRunResult {
  result: ToolResult;
  transcriptResult: DeterministicTranscriptCheckResult;
}

export interface DeterministicCheckDisplay {
  label: string;
  detail?: string;
}

export interface DeterministicCheckPlanEntry {
  display: DeterministicCheckDisplay;
  failFast: boolean;
  run(
    context: DeterministicCheckExecutionContext,
  ): Promise<DeterministicCheckRunResult>;
}

export function buildDeterministicCheckRunPlan(
  config: PushgateConfig,
): DeterministicCheckPlanEntry[] {
  return [
    ...buildBuiltInPolicyEntries(config.policies),
    ...buildPluginEntries(config),
    ...config.tools.map(buildConfiguredToolEntry),
  ];
}

function buildBuiltInPolicyEntries(
  policies: BuiltInPoliciesConfig,
): DeterministicCheckPlanEntry[] {
  const entries: DeterministicCheckPlanEntry[] = [];

  if (policies.diff_size) {
    entries.push(
      buildBuiltInPolicyEntry({
        label: "Diff size",
        policies: {
          diff_size: policies.diff_size,
        },
        resultName: "policy:diff_size",
        transformDetail: formatDiffSizeDisplayDetail,
      }),
    );
  }

  if (policies.forbidden_paths) {
    entries.push(
      buildBuiltInPolicyEntry({
        label: "Forbidden paths",
        policies: {
          forbidden_paths: policies.forbidden_paths,
        },
        resultName: "policy:forbidden_paths",
      }),
    );
  }

  return entries;
}

function buildBuiltInPolicyEntry(options: {
  label: string;
  policies: BuiltInPoliciesConfig;
  resultName: string;
  transformDetail?: (detail: string | undefined) => string | undefined;
}): DeterministicCheckPlanEntry {
  return {
    display: {
      label: options.label,
    },
    failFast: false,
    async run(context) {
      const result = runBuiltInPolicies(
        options.policies,
        context.changedFileResolution.files,
      )[0];

      if (!result) {
        throw new Error(
          `Built-In Policy ${options.resultName} did not produce a result.`,
        );
      }

      return {
        result,
        transcriptResult: {
          detail: options.transformDetail
            ? options.transformDetail(result.detail)
            : result.detail,
          label: options.label,
          status: result.status,
        },
      };
    },
  };
}

function buildPluginEntries(config: PushgateConfig): DeterministicCheckPlanEntry[] {
  const entries: DeterministicCheckPlanEntry[] = [];

  if (config.plugins.gitleaks?.enabled) {
    entries.push(buildGitleaksPluginEntry(config.plugins.gitleaks));
  }

  return entries;
}

function buildGitleaksPluginEntry(
  plugin: GitleaksPluginConfig,
): DeterministicCheckPlanEntry {
  return {
    display: {
      detail: "gitleaks",
      label: "Secrets scan",
    },
    failFast: plugin.fail_fast,
    async run(context) {
      const name = "plugin:gitleaks";
      const commandResult = await runGitleaksPlugin(
        plugin,
        context.changedFileResolution,
        context.repoRoot,
        context.env,
      );
      const result: ToolResult = commandResult.passed
        ? { name, status: "passed" }
        : {
            name,
            status: modeToStatus(plugin.mode),
            detail: commandResult.detail,
            outputTail: commandResult.outputTail,
          };

      return {
        result,
        transcriptResult: {
          detail: result.detail ? result.detail : "gitleaks",
          label: "Secrets scan",
          outputTail: result.outputTail,
          status: result.status,
        },
      };
    },
  };
}

function buildConfiguredToolEntry(tool: ToolConfig): DeterministicCheckPlanEntry {
  const label = humanizeIdentifier(tool.name);

  return {
    display: {
      label,
    },
    failFast: tool.fail_fast,
    async run(context) {
      const selectedPaths = selectToolChangedFilePaths(
        context.changedFileResolution.files,
        tool.extensions,
      );

      if (tool.run === "changed_files" && selectedPaths.length === 0) {
        return checkResult({
          label,
          result: {
            name: tool.name,
            status: "skipped",
            detail: "no matching changed files",
          },
        });
      }

      const commandResult = await runToolCommand(
        tool,
        selectedPaths,
        context.repoRoot,
        context.env,
      );
      const result: ToolResult = commandResult.passed
        ? { name: tool.name, status: "passed" }
        : {
            name: tool.name,
            status: modeToStatus(tool.mode),
            detail: commandResult.detail,
            outputTail: commandResult.outputTail,
          };

      return checkResult({
        label,
        result,
      });
    },
  };
}

function checkResult(options: {
  label: string;
  result: ToolResult;
}): DeterministicCheckRunResult {
  return {
    result: options.result,
    transcriptResult: {
      detail: options.result.detail,
      label: options.label,
      outputTail: options.result.outputTail,
      status: options.result.status,
    },
  };
}

function modeToStatus(mode: "blocking" | "warning"): ToolResultStatus {
  return mode === "warning" ? "warning" : "blocked";
}

function formatDiffSizeDisplayDetail(
  detail: string | undefined,
): string | undefined {
  if (!detail) {
    return undefined;
  }

  const passed = detail.match(
    /^(\d+) changed line\(s\) within max_changed_lines (\d+)$/,
  );

  return passed ? `${passed[1]} / ${passed[2]} changed lines` : detail;
}

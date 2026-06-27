import type { ToolConfig } from "../config/index.js";
import {
  formatCount,
  humanizeIdentifier,
  writeDetail,
  writeIndentedBlock,
  writeLine,
  writeResultRow,
  writeSection,
  type TerminalStatus,
} from "../terminal/format.js";
import type { ToolResult } from "./deterministic.js";
import type { BuiltInPolicyResult } from "./policies.js";
import type { DeterministicResultSummary } from "./summary.js";

export interface DeterministicTranscript {
  writeFailFast(): void;
  writeNoChecks(): void;
  writePluginResult(name: string, result: ToolResult): void;
  writePolicyResult(result: BuiltInPolicyResult): void;
  writeStart(checkCount: number): void;
  writeSummary(summary: DeterministicResultSummary): void;
  writeToolResult(tool: ToolConfig, result: ToolResult): void;
}

export function createDeterministicTranscript(
  stdout: NodeJS.WritableStream,
): DeterministicTranscript {
  const warnings: string[] = [];
  const blockers: string[] = [];

  return {
    writeFailFast() {
      writeDetail(stdout, "Stopped after a blocking failure because fail_fast is true.");
    },

    writeNoChecks() {
      writeSection(stdout, "Checks");
      writeResultRow(stdout, "skipped", "No checks configured");
      writeLine(stdout);
    },

    writePolicyResult(result) {
      writeCheckResult(result.name, result);
    },

    writePluginResult(name, result) {
      writeCheckResult(name, result);
    },

    writeStart(checkCount) {
      writeSection(stdout, "Checks");
      writeDetail(stdout, `Running ${formatCount(checkCount, "check")}.`);
    },

    writeSummary(summary) {
      writeLine(stdout);

      if (summary.blockedCount > 0) {
        writeLine(
          stdout,
          `Checks completed with ${formatCount(summary.blockedCount, "blocking failure")} and ${formatCount(summary.warningCount, "warning")}.`,
        );
        writeLine(stdout);
        writeSection(stdout, summary.blockedCount === 1 ? "Blocked" : "Blocked checks");

        for (const blocker of blockers) {
          writeDetail(stdout, `${blocker} failed and is configured as a blocking check.`);
        }

        writeLine(stdout);
        writeLine(
          stdout,
          "Fix the blocking failures above, or use `git push --no-verify` only when you intend to bypass local hooks.",
        );
        return;
      }

      if (summary.warningCount > 0) {
        writeLine(
          stdout,
          `Checks completed with ${formatCount(summary.warningCount, "non-blocking warning")}.`,
        );
        writeLine(stdout);
        writeSection(stdout, summary.warningCount === 1 ? "Warning" : "Warnings");

        for (const warning of warnings) {
          writeDetail(stdout, `${warning} failed, but this check does not block the push.`);
        }
        writeLine(stdout);
        return;
      }

      writeLine(stdout, "Checks passed.");
      writeLine(stdout);
    },

    writeToolResult(tool, result) {
      writeCheckResult(tool.name, result);
    },
  };

  function writeCheckResult(
    name: string,
    result: Pick<ToolResult, "detail" | "status" | "outputTail">,
  ): void {
    const display = displayCheck(name);
    const detail = formatDetail(name, result.detail);
    const status = mapStatus(result.status);

    writeResultRow(stdout, status, display.label, detail ?? display.detail);

    if (result.outputTail) {
      writeDetail(stdout, "Command output:");
      writeIndentedBlock(stdout, result.outputTail.split("\n"));
    }

    if (result.status === "warning") {
      warnings.push(display.label);
    }

    if (result.status === "blocked") {
      blockers.push(display.label);
    }
  }
}

function displayCheck(name: string): { detail?: string; label: string } {
  if (name === "policy:diff_size") {
    return { label: "Diff size" };
  }

  if (name === "policy:forbidden_paths") {
    return { label: "Forbidden paths" };
  }

  if (name === "plugin:gitleaks") {
    return { detail: "gitleaks", label: "Secrets scan" };
  }

  return { label: humanizeIdentifier(name) };
}

function formatDetail(name: string, detail: string | undefined): string | undefined {
  if (!detail) {
    return undefined;
  }

  if (name === "policy:diff_size") {
    const passed = detail.match(
      /^(\d+) changed line\(s\) within max_changed_lines (\d+)$/,
    );

    if (passed) {
      return `${passed[1]} / ${passed[2]} changed lines`;
    }
  }

  return detail;
}

function mapStatus(status: ToolResult["status"]): TerminalStatus {
  const statusByResult = {
    blocked: "blocked",
    passed: "passed",
    skipped: "skipped",
    warning: "warning",
  } as const satisfies Record<ToolResult["status"], TerminalStatus>;

  return statusByResult[status];
}

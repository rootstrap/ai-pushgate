import {
  formatCount,
  writeDetail,
  writeIndentedBlock,
  writeLine,
  writeResultRow,
  writeSection,
  type TerminalStatus,
} from "../terminal/format.js";
import type { ToolResult } from "./deterministic.js";
import type { DeterministicResultSummary } from "./summary.js";

export interface DeterministicTranscriptCheckResult {
  label: string;
  status: ToolResult["status"];
  detail?: string;
  outputTail?: string;
}

export interface DeterministicTranscript {
  writeFailFast(): void;
  writeCheckResult(result: DeterministicTranscriptCheckResult): void;
  writeNoChecks(): void;
  writeStart(checkCount: number): void;
  writeSummary(summary: DeterministicResultSummary): void;
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

    writeCheckResult(result) {
      writeRenderedCheckResult(result);
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
  };

  function writeRenderedCheckResult(
    result: DeterministicTranscriptCheckResult,
  ): void {
    const status = mapStatus(result.status);

    writeResultRow(stdout, status, result.label, result.detail);

    if (result.outputTail) {
      writeDetail(stdout, "Command output:");
      writeIndentedBlock(stdout, result.outputTail.split("\n"));
    }

    if (result.status === "warning") {
      warnings.push(result.label);
    }

    if (result.status === "blocked") {
      blockers.push(result.label);
    }
  }
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

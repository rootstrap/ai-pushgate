import {
  formatResultRow,
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

export interface DeterministicTranscriptPlannedCheck {
  label: string;
  detail?: string;
}

export interface DeterministicTranscript {
  writeFailFast(): void;
  writeCheckResult(result: DeterministicTranscriptCheckResult): void;
  writeNoChecks(): void;
  writeStart(checks: readonly DeterministicTranscriptPlannedCheck[]): void;
  writeSummary(summary: DeterministicResultSummary): void;
}

export function createDeterministicTranscript(
  stdout: NodeJS.WritableStream,
): DeterministicTranscript {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const plannedChecks: DeterministicTranscriptPlannedCheck[] = [];
  const liveUpdates = supportsLiveUpdates(stdout);
  let completedCheckCount = 0;
  let linesBelowCheckRows = 0;

  return {
    writeFailFast() {
      writeSkippedRemainingChecks("not run after fail_fast");
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

    writeStart(checks) {
      plannedChecks.push(...checks);

      writeSection(stdout, "Checks");
      writeDetail(stdout, `Running ${formatCount(checks.length, "check")}.`);

      for (const check of checks) {
        writeResultRow(stdout, "running", check.label, check.detail);
      }
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

    writeCompletedCheckResult(status, result);

    if (result.outputTail) {
      writeCommandOutputTail(result.outputTail);
    }

    if (result.status === "warning") {
      warnings.push(result.label);
    }

    if (result.status === "blocked") {
      blockers.push(result.label);
    }
  }

  function writeCompletedCheckResult(
    status: TerminalStatus,
    result: DeterministicTranscriptCheckResult,
  ): void {
    const plannedCheck = plannedChecks[completedCheckCount];
    const detail = result.detail ?? plannedCheck?.detail;

    writeCompletedCheckRow(status, result.label, detail);
  }

  function writeSkippedRemainingChecks(detail: string): void {
    while (completedCheckCount < plannedChecks.length) {
      const plannedCheck = plannedChecks[completedCheckCount];

      if (!plannedCheck) {
        return;
      }

      writeCompletedCheckRow("skipped", plannedCheck.label, detail);
    }
  }

  function writeCompletedCheckRow(
    status: TerminalStatus,
    label: string,
    detail: string | undefined,
  ): void {
    if (liveUpdates && plannedChecks[completedCheckCount]) {
      replacePlannedCheckRow(completedCheckCount, status, label, detail);
    } else {
      writeResultRow(stdout, status, label, detail);
    }

    completedCheckCount += 1;
  }

  function replacePlannedCheckRow(
    index: number,
    status: TerminalStatus,
    label: string,
    detail: string | undefined,
  ): void {
    const distanceFromCursor =
      linesBelowCheckRows + plannedChecks.length - index;

    stdout.write(
      `\u001B[${distanceFromCursor}A\r\u001B[2K${formatResultRow(
        status,
        label,
        detail,
        { stream: stdout },
      )}\u001B[${distanceFromCursor}B\r`,
    );
  }

  function writeCommandOutputTail(outputTail: string): void {
    const lines = outputTail.split("\n");

    writeDetail(stdout, "Command output:");
    writeIndentedBlock(stdout, lines);
    linesBelowCheckRows += 1 + lines.length;
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

function supportsLiveUpdates(stream: NodeJS.WritableStream): boolean {
  const output = stream as NodeJS.WritableStream & {
    isTTY?: boolean;
  };

  return output.isTTY === true && process.env.TERM !== "dumb";
}

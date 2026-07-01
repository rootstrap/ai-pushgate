import { SKIP_AI_CHECK_CONFIG_KEY } from "../skip-controls.js";
import {
  capitalize,
  formatCount,
  formatResultRow,
  writeDetail,
  writeIndentedBlock,
  writeLine,
  writeResultRow,
  writeSection,
  type TerminalStatus,
} from "../terminal/format.js";
import type {
  DeterministicTranscriptCheckResult,
  DeterministicTranscriptCheckStatus,
  DeterministicTranscriptPlannedCheck,
  DeterministicTranscriptSummary,
  LocalAiSkipReason,
  LocalAiTranscriptEvent,
  WarningConfirmationPhase,
} from "./events.js";

export interface DeterministicTranscript {
  writeFailFast(): void;
  writeCheckResult(result: DeterministicTranscriptCheckResult): void;
  writeNoChecks(): void;
  writeStart(checks: readonly DeterministicTranscriptPlannedCheck[]): void;
  writeSummary(summary: DeterministicTranscriptSummary): void;
}

export interface LocalAiTranscript {
  writeEvents(events: readonly LocalAiTranscriptEvent[]): void;
  writeSection(): void;
  writeSkipped(options: { reason: LocalAiSkipReason }): void;
}

export interface WarningConfirmationTranscript {
  writeConfirmed(options: {
    phase: WarningConfirmationPhase;
    warningCount: number;
  }): void;
  writeDeclined(options: {
    phase: WarningConfirmationPhase;
    warningCount: number;
  }): void;
  writeUnavailable(options: { message: string }): void;
}

export interface PushTranscript {
  writePassed(): void;
}

export interface PushgateTranscript {
  deterministic: DeterministicTranscript;
  localAi: LocalAiTranscript;
  push: PushTranscript;
  warningConfirmation: WarningConfirmationTranscript;
}

export function createPushgateTranscript(
  stdout: NodeJS.WritableStream,
): PushgateTranscript {
  return {
    deterministic: createDeterministicTranscript(stdout),
    localAi: createLocalAiTranscript(stdout),
    push: createPushTranscript(stdout),
    warningConfirmation: createWarningConfirmationTranscript(stdout),
  };
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
      writeDetail(
        stdout,
        "Stopped after a blocking failure because fail_fast is true.",
      );
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
        writeSection(
          stdout,
          summary.blockedCount === 1 ? "Blocked" : "Blocked checks",
        );

        for (const blocker of blockers) {
          writeDetail(
            stdout,
            `${blocker} failed and is configured as a blocking check.`,
          );
        }

        writeLine(stdout);
        writeLine(
          stdout,
          "Fix the blocking failures above, or use `git push --no-verify` only when you intend to bypass the Local Push Gate.",
        );
        return;
      }

      if (summary.warningCount > 0) {
        writeLine(
          stdout,
          `Checks completed with ${formatCount(summary.warningCount, "non-blocking warning")}.`,
        );
        writeLine(stdout);
        writeSection(
          stdout,
          summary.warningCount === 1 ? "Warning" : "Warnings",
        );

        for (const warning of warnings) {
          writeDetail(
            stdout,
            `${warning} failed, but this check does not block the push.`,
          );
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
    const status = mapDeterministicStatus(result.status);

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

export function createLocalAiTranscript(
  stdout: NodeJS.WritableStream,
): LocalAiTranscript {
  const streamingState: LocalAiStreamingTranscriptState = {
    responseEmptyRendered: false,
    responseLineStart: true,
    responseStarted: false,
    responseWroteText: false,
    validatedFindingsStarted: false,
    waitSpinnerActive: false,
    waitSpinnerFrame: 0,
  };

  return {
    writeEvents(events) {
      for (const event of events) {
        renderLocalAiTranscriptEvent(event, stdout, streamingState);
      }
    },

    writeSection() {
      writeSection(stdout, "AI review");
    },

    writeSkipped(options) {
      if (options.reason === "local-ai-mode-off") {
        return;
      }

      writeSection(stdout, "AI review");
      writeResultRow(
        stdout,
        "skipped",
        "Local AI Review",
        `skipped because ${SKIP_AI_CHECK_CONFIG_KEY}=true`,
      );
    },
  };
}

interface LocalAiStreamingTranscriptState {
  responseEmptyRendered: boolean;
  responseLineStart: boolean;
  responseStarted: boolean;
  responseWroteText: boolean;
  validatedFindingsStarted: boolean;
  waitSpinnerActive: boolean;
  waitSpinnerFrame: number;
  waitSpinnerLabel?: string;
  waitSpinnerTimer?: NodeJS.Timeout;
}

function createWarningConfirmationTranscript(
  stdout: NodeJS.WritableStream,
): WarningConfirmationTranscript {
  return {
    writeConfirmed(options) {
      writeLine(
        stdout,
        `Warning Confirmation accepted: continuing with ${String(options.warningCount)} warning(s) from ${options.phase}.`,
      );
    },

    writeDeclined(options) {
      writeLine(
        stdout,
        `Push blocked because Warning Confirmation was declined for ${String(options.warningCount)} warning(s) from ${options.phase}.`,
      );
    },

    writeUnavailable(options) {
      writeLine(stdout, options.message);
      writeLine(
        stdout,
        "Push blocked because Warning Confirmation could not be collected.",
      );
    },
  };
}

function createPushTranscript(
  stdout: NodeJS.WritableStream,
): PushTranscript {
  return {
    writePassed() {
      writeLine(stdout);
      writeLine(stdout, "Local Push Gate passed. Push allowed.");
    },
  };
}

function renderLocalAiTranscriptEvent(
  event: LocalAiTranscriptEvent,
  stdout: NodeJS.WritableStream,
  streamingState: LocalAiStreamingTranscriptState,
): void {
  switch (event.kind) {
    case "skip-no-files":
      writeResultRow(stdout, "skipped", "No changed files to review");
      return;
    case "block-changed-lines":
      writeResultRow(
        stdout,
        "blocked",
        "Changed lines",
        `${String(event.changedLineCount)} changed lines exceed ai.max_changed_lines ${String(event.maxChangedLines)}`,
      );
      return;
    case "skip-prompt-tokens":
      writeResultRow(
        stdout,
        "skipped",
        "Prompt budget",
        `approximately ${String(event.estimatedPromptTokens)} tokens exceeds ai.max_prompt_tokens ${String(event.maxPromptTokens)}`,
      );
      return;
    case "review-start":
      writeDetail(stdout, `Provider: ${event.providerLabel}`);
      writeDetail(stdout, `Files reviewed: ${String(event.changedFileCount)}`);
      return;
    case "full-file-context":
      writeDetail(
        stdout,
        `Context: ${formatCount(event.diffLineCount, "diff line")} plus ${formatCount(event.fullFileCount, "full file")} for extra context`,
      );
      return;
    case "provider-progress":
      stopProviderWait(stdout, streamingState);
      writeDetail(stdout, event.message);
      return;
    case "provider-wait-start":
      startProviderWait(stdout, streamingState, event.providerLabel);
      return;
    case "provider-wait-stop":
      stopProviderWait(stdout, streamingState);
      return;
    case "provider-response-start":
      stopProviderWait(stdout, streamingState);
      startProviderResponse(stdout, streamingState, event.providerLabel);
      return;
    case "provider-response-delta":
      writeProviderResponseDelta(stdout, streamingState, event.text);
      return;
    case "provider-response-empty":
      writeEmptyProviderResponse(stdout, streamingState);
      return;
    case "validated-findings-start":
      startValidatedFindings(stdout, streamingState);
      return;
    case "provider-failure": {
      const status = event.aiMode === "advisory" ? "warning" : "blocked";

      writeResultRow(
        stdout,
        status,
        `${capitalize(event.result.provider)} provider`,
        event.result.message,
      );

      if (event.result.detail) {
        writeDetail(stdout, "Detail:");
        writeIndentedBlock(stdout, event.result.detail.split("\n"));
      }

      if (event.result.output) {
        writeDetail(stdout, "Provider output:");
        writeIndentedBlock(stdout, event.result.output.split("\n"));
      }

      return;
    }
    case "normalization-note":
      writeDetail(stdout, `Note: ${event.note}`);
      return;
    case "review-passed":
      writeResultRow(stdout, "passed", "No findings");
      return;
    case "finding": {
      const status =
        event.finding.severity === "blocking" ? "blocked" : "warning";
      const location =
        event.finding.line === "N/A"
          ? event.finding.file
          : `${event.finding.file}:${event.finding.line}`;

      writeResultRow(
        stdout,
        status,
        `AI ${humanizeCategory(event.finding.category)}`,
        location,
      );
      writeDetail(stdout, `Message: ${event.finding.message}`);
      writeDetail(stdout, `Suggestion: ${event.finding.suggestion}`);
      return;
    }
    case "review-summary":
      if (
        event.summary.blockingCount > 0 ||
        event.summary.warningCount > 0
      ) {
        writeDetail(
          stdout,
          `Finished with ${formatCount(event.summary.blockingCount, "blocking finding")} and ${formatCount(event.summary.warningCount, "warning")}.`,
        );
      }
      return;
    case "advisory-continue":
      writeDetail(stdout, "Continuing because ai.mode is advisory.");
      return;
    case "provider-blocked":
      writeLine(stdout);
      writeLine(stdout, "Local AI Review is blocking in this repository.");
      writeLine(
        stdout,
        `Fix the provider issue, or use \`git -c ${SKIP_AI_CHECK_CONFIG_KEY}=true push\` to bypass only Local AI Review for this push.`,
      );
      return;
    case "review-blocked":
      writeLine(stdout);
      writeLine(stdout, "Local AI Review blocked the push.");
      writeLine(
        stdout,
        `Fix the findings above, or use \`git -c ${SKIP_AI_CHECK_CONFIG_KEY}=true push\` to bypass only Local AI Review for this push.`,
      );
      return;
  }
}

function startProviderResponse(
  stdout: NodeJS.WritableStream,
  state: LocalAiStreamingTranscriptState,
  providerLabel: string,
): void {
  if (state.responseStarted) {
    return;
  }

  writeLine(stdout);
  writeSection(stdout, `${providerLabel} response`);
  state.responseStarted = true;
  state.responseLineStart = true;
}

const WAIT_SPINNER_FRAMES = ["-", "\\", "|", "/"] as const;

function startProviderWait(
  stdout: NodeJS.WritableStream,
  state: LocalAiStreamingTranscriptState,
  providerLabel: string,
): void {
  if (!supportsLiveUpdates(stdout) || state.waitSpinnerTimer) {
    return;
  }

  state.waitSpinnerActive = true;
  state.waitSpinnerFrame = 0;
  state.waitSpinnerLabel = `Waiting for ${providerLabel}...`;
  renderProviderWait(stdout, state);
  state.waitSpinnerTimer = setInterval(() => {
    state.waitSpinnerFrame =
      (state.waitSpinnerFrame + 1) % WAIT_SPINNER_FRAMES.length;
    renderProviderWait(stdout, state);
  }, 120);
  state.waitSpinnerTimer.unref?.();
}

function stopProviderWait(
  stdout: NodeJS.WritableStream,
  state: LocalAiStreamingTranscriptState,
): void {
  if (state.waitSpinnerTimer) {
    clearInterval(state.waitSpinnerTimer);
    state.waitSpinnerTimer = undefined;
  }

  if (state.waitSpinnerActive) {
    stdout.write("\r\u001B[2K");
  }

  state.waitSpinnerActive = false;
  state.waitSpinnerLabel = undefined;
}

function renderProviderWait(
  stdout: NodeJS.WritableStream,
  state: LocalAiStreamingTranscriptState,
): void {
  if (!state.waitSpinnerActive || !state.waitSpinnerLabel) {
    return;
  }

  const frame = WAIT_SPINNER_FRAMES[state.waitSpinnerFrame] ?? "-";

  stdout.write(`\r  ${frame} ${state.waitSpinnerLabel}`);
}

function writeProviderResponseDelta(
  stdout: NodeJS.WritableStream,
  state: LocalAiStreamingTranscriptState,
  text: string,
): void {
  if (!state.responseStarted) {
    startProviderResponse(stdout, state, "Provider");
  }

  const sanitized = sanitizeProviderResponseText(text);

  if (sanitized.length === 0) {
    return;
  }

  state.responseWroteText = true;

  for (const char of sanitized) {
    if (state.responseLineStart) {
      stdout.write("  ");
      state.responseLineStart = false;
    }

    stdout.write(char);

    if (char === "\n") {
      state.responseLineStart = true;
    }
  }
}

function writeEmptyProviderResponse(
  stdout: NodeJS.WritableStream,
  state: LocalAiStreamingTranscriptState,
): void {
  if (
    !state.responseStarted ||
    state.responseWroteText ||
    state.responseEmptyRendered
  ) {
    return;
  }

  writeDetail(stdout, "No streamable response text was produced by this provider.");
  state.responseEmptyRendered = true;
  state.responseLineStart = true;
}

function startValidatedFindings(
  stdout: NodeJS.WritableStream,
  state: LocalAiStreamingTranscriptState,
): void {
  stopProviderWait(stdout, state);

  if (state.validatedFindingsStarted) {
    return;
  }

  if (state.responseStarted) {
    if (!state.responseLineStart) {
      writeLine(stdout);
    }

    writeEmptyProviderResponse(stdout, state);
  }

  writeLine(stdout);
  writeSection(stdout, "Validated findings");
  state.validatedFindingsStarted = true;
}

const ANSI_ESCAPE_PATTERN =
  /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;
const UNSAFE_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g;

function sanitizeProviderResponseText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(UNSAFE_CONTROL_PATTERN, "");
}

function mapDeterministicStatus(
  status: DeterministicTranscriptCheckStatus,
): TerminalStatus {
  const statusByResult = {
    blocked: "blocked",
    passed: "passed",
    skipped: "skipped",
    warning: "warning",
  } as const satisfies Record<DeterministicTranscriptCheckStatus, TerminalStatus>;

  return statusByResult[status];
}

function supportsLiveUpdates(stream: NodeJS.WritableStream): boolean {
  const output = stream as NodeJS.WritableStream & {
    isTTY?: boolean;
  };

  return output.isTTY === true && process.env.TERM !== "dumb";
}

function humanizeCategory(category: string): string {
  return category.replace(/_/g, " ");
}

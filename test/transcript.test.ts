import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import { createPushgateTranscript } from "../src/transcript/index.js";

test("renders Local AI Review Skip Control and final pass copy", () => {
  const output = captureOutput();
  const transcript = createPushgateTranscript(output.stream);

  transcript.localAi.writeSkipped({ reason: "skip-ai-check" });
  transcript.push.writePassed();

  assert.equal(
    output.text(),
    [
      "AI review",
      "  [skip] Local AI Review    skipped because pushgate.skip-ai-check=true",
      "",
      "Local Push Gate passed. Push allowed.",
      "",
    ].join("\n"),
  );
});

test("keeps local AI mode off silent", () => {
  const output = captureOutput();
  const transcript = createPushgateTranscript(output.stream);

  transcript.localAi.writeSkipped({ reason: "local-ai-mode-off" });

  assert.equal(output.text(), "");
});

test("renders Warning Confirmation outcomes", () => {
  const output = captureOutput();
  const transcript = createPushgateTranscript(output.stream);

  transcript.warningConfirmation.writeConfirmed({
    phase: "deterministic checks",
    warningCount: 1,
  });
  transcript.warningConfirmation.writeDeclined({
    phase: "local AI review",
    warningCount: 2,
  });
  transcript.warningConfirmation.writeUnavailable({
    message:
      "Warning confirmation required for local AI review, but no interactive terminal is available.",
  });

  assert.equal(
    output.text(),
    [
      "Warning Confirmation accepted: continuing with 1 warning(s) from deterministic checks.",
      "Push blocked because Warning Confirmation was declined for 2 warning(s) from local AI review.",
      "Warning confirmation required for local AI review, but no interactive terminal is available.",
      "Push blocked because Warning Confirmation could not be collected.",
      "",
    ].join("\n"),
  );
});

test("renders Local AI Review blocking copy with AI Skip Control guidance", () => {
  const output = captureOutput();
  const transcript = createPushgateTranscript(output.stream);

  transcript.localAi.writeEvents([
    {
      kind: "provider-failure",
      aiMode: "blocking",
      result: {
        kind: "provider-error",
        code: "missing_binary",
        provider: "claude",
        message: "Claude Code CLI was not found on PATH.",
      },
    },
    { kind: "provider-blocked" },
    {
      kind: "finding",
      finding: {
        category: "logic_errors",
        confidence: "high",
        file: "src/changed.ts",
        line: "7",
        message: "The changed branch returns the wrong value.",
        severity: "blocking",
        source: {
          provider: "claude",
        },
        suggestion: "Return the intended value.",
      },
    },
    {
      kind: "review-summary",
      summary: {
        blockingCount: 1,
        verdict: "BLOCK",
        warningCount: 0,
      },
    },
    { kind: "review-blocked" },
  ]);

  assert.match(output.text(), /\[block\] Claude provider\s+Claude Code CLI was not found on PATH/);
  assert.match(output.text(), /Local AI Review is blocking in this repository/);
  assert.match(output.text(), /git -c pushgate\.skip-ai-check=true push/);
  assert.match(output.text(), /\[block\] AI logic errors\s+src\/changed\.ts:7/);
  assert.match(output.text(), /Local AI Review blocked the push/);
});

test("renders Deterministic Check blocking copy with Local Push Gate guidance", () => {
  const output = captureOutput();
  const transcript = createPushgateTranscript(output.stream);

  transcript.deterministic.writeStart([
    {
      label: "Lint",
    },
  ]);
  transcript.deterministic.writeCheckResult({
    detail: "exited with code 1",
    label: "Lint",
    status: "blocked",
  });
  transcript.deterministic.writeSummary({
    blockedCount: 1,
    exitCode: 1,
    warningCount: 0,
  });

  assert.match(output.text(), /Checks completed with 1 blocking failure and 0 warnings/);
  assert.match(output.text(), /Lint failed and is configured as a blocking check/);
  assert.match(output.text(), /git push --no-verify/);
  assert.match(output.text(), /bypass the Local Push Gate/);
});

test("renders and clears a TTY local AI provider wait spinner", () => {
  const output = captureOutput({ isTTY: true });
  const transcript = createPushgateTranscript(output.stream);
  const previousTerm = process.env.TERM;

  try {
    process.env.TERM = "xterm-256color";
    transcript.localAi.writeEvents([
      {
        kind: "provider-wait-start",
        providerLabel: "GitHub Copilot",
      },
      {
        kind: "provider-wait-stop",
      },
      {
        kind: "validated-findings-start",
      },
      {
        kind: "review-passed",
      },
    ]);
  } finally {
    if (previousTerm === undefined) {
      delete process.env.TERM;
    } else {
      process.env.TERM = previousTerm;
    }
  }

  assert.match(output.text(), /Waiting for GitHub Copilot\.\.\./);
  assert.match(output.text(), /\r\u001B\[2K\nValidated findings/);
});

function captureOutput(options: { isTTY?: boolean } = {}): {
  stream: Writable;
  text(): string;
} {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk);
      callback();
    },
  });

  if (options.isTTY !== undefined) {
    Object.defineProperty(stream, "isTTY", {
      configurable: true,
      value: options.isTTY,
    });
  }

  return {
    stream,
    text() {
      return output;
    },
  };
}

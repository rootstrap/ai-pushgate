import type { ToolConfig } from "../config/index.js";
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
  return {
    writeFailFast() {
      writeLine(
        stdout,
        "[pushgate] Stopping deterministic checks after blocking failure because fail_fast is true.",
      );
    },

    writeNoChecks() {
      writeLine(stdout, "[pushgate] No deterministic checks configured.");
    },

    writePolicyResult(result) {
      const labelByStatus = {
        blocked: "BLOCK",
        passed: "PASS",
        warning: "WARN",
      } as const;
      const detail = result.detail ? `: ${result.detail}` : "";

      writeLine(
        stdout,
        `[pushgate] ${labelByStatus[result.status]} ${result.name}${detail}.`,
      );
    },

    writePluginResult(name, result) {
      writeRunnableResult(name, result);
    },

    writeStart(checkCount) {
      writeLine(
        stdout,
        `[pushgate] Running ${String(checkCount)} deterministic check(s).`,
      );
    },

    writeSummary(summary) {
      writeLine(
        stdout,
        `[pushgate] Deterministic checks finished: ${String(summary.blockedCount)} blocking failure(s), ${String(summary.warningCount)} warning(s).`,
      );

      if (summary.blockedCount > 0) {
        writeLine(
          stdout,
          "[pushgate] Fix the blocking command failures before pushing, or use git push --no-verify to bypass local hooks intentionally.",
        );
      }
    },

    writeToolResult(tool, result) {
      writeRunnableResult(tool.name, result);
    },
  };

  function writeRunnableResult(name: string, result: ToolResult): void {
    if (result.status === "passed") {
      writeLine(stdout, `[pushgate] PASS ${name}.`);
      return;
    }

    if (result.status === "skipped") {
      writeLine(stdout, `[pushgate] SKIP ${name}: ${result.detail}.`);
      return;
    }

    const label = result.status === "warning" ? "WARN" : "BLOCK";

    writeLine(
      stdout,
      `[pushgate] ${label} ${name}: ${result.detail ?? "command failed"}.`,
    );

    if (result.outputTail) {
      writeLine(stdout, "[pushgate] Command output:");

      for (const line of result.outputTail.split("\n")) {
        writeLine(stdout, `[pushgate]   ${line}`);
      }
    }
  }
}

function writeLine(stream: NodeJS.WritableStream, line: string): void {
  stream.write(`${line}\n`);
}

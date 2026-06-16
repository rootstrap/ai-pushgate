import type { ToolResult } from "./deterministic.js";

export interface DeterministicResultSummary {
  blockedCount: number;
  exitCode: number;
  warningCount: number;
}

export function summarizeDeterministicResults(
  results: readonly ToolResult[],
): DeterministicResultSummary {
  const blockedCount = results.filter((result) => result.status === "blocked")
    .length;
  const warningCount = results.filter((result) => result.status === "warning")
    .length;

  return {
    blockedCount,
    exitCode: blockedCount > 0 ? 1 : 0,
    warningCount,
  };
}

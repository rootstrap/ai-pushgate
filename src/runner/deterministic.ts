import type { PushgateConfig } from "../config/index.js";
import type { ChangedFileResolution } from "../path-policy/index.js";
import {
  createDeterministicTranscript,
  type DeterministicTranscript,
} from "../transcript/index.js";
import { buildDeterministicCheckRunPlan } from "./deterministic-plan.js";
import { summarizeDeterministicResults } from "./summary.js";

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
  transcript?: DeterministicTranscript;
}

export function buildDeterministicCheckPlan(
  config: PushgateConfig,
): DeterministicCheckPlan {
  const checkCount = buildDeterministicCheckRunPlan(config).length;

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
  const repoRoot = request.repoRoot ?? process.cwd();
  const env = request.env ?? process.env;
  const results: ToolResult[] = [];
  const transcript =
    request.transcript ?? createDeterministicTranscript(process.stdout);
  const runPlan = buildDeterministicCheckRunPlan(config);

  if (runPlan.length === 0) {
    transcript.writeNoChecks();
    return { exitCode: 0, results };
  }

  const changedFileResolution = requireChangedFileResolution(
    request.changedFileResolution,
  );

  transcript.writeStart(runPlan.map((entry) => entry.display));

  for (const entry of runPlan) {
    const entryResult = await entry.run({
      changedFileResolution,
      env,
      repoRoot,
    });

    results.push(entryResult.result);
    transcript.writeCheckResult(entryResult.transcriptResult);

    if (entryResult.result.status === "blocked" && entry.failFast) {
      transcript.writeFailFast();
      break;
    }
  }

  const resultSummary = summarizeDeterministicResults(results);

  transcript.writeSummary(resultSummary);
  return { exitCode: resultSummary.exitCode, results };
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

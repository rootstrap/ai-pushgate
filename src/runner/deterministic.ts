import type { PushgateConfig, ToolConfig } from "../config/index.js";
import {
  selectToolChangedFilePaths,
  type ChangedFile,
} from "../path-policy/index.js";
import { runTimedCommand } from "../process/timed-command.js";
import {
  countBuiltInPolicies,
  runBuiltInPolicies,
  type BuiltInPolicyResult,
} from "./policies.js";

export const CHANGED_FILES_TOKEN = "{changed_files}" as const;

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

export interface DeterministicCheckOptions {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  stderr?: NodeJS.WritableStream;
  stdout?: NodeJS.WritableStream;
}

interface ToolCommandResult {
  passed: boolean;
  detail?: string;
  outputTail?: string;
}

const OUTPUT_CAPTURE_LIMIT = 64 * 1024;
const OUTPUT_TAIL_LIMIT = 4 * 1024;
const TIMEOUT_KILL_GRACE_MS = 1_000;

export async function runDeterministicChecks(
  config: PushgateConfig,
  changedFiles: readonly ChangedFile[],
  options: DeterministicCheckOptions = {},
): Promise<DeterministicCheckSummary> {
  const stdout = options.stdout ?? process.stdout;
  const repoRoot = options.repoRoot ?? process.cwd();
  const env = options.env ?? process.env;
  const results: ToolResult[] = [];
  const policyCount = countBuiltInPolicies(config.policies);
  const checkCount = policyCount + config.tools.length;

  if (checkCount === 0) {
    writeLine(stdout, "[pushgate] No deterministic checks configured.");
    return { exitCode: 0, results };
  }

  writeLine(
    stdout,
    `[pushgate] Running ${String(checkCount)} deterministic check(s).`,
  );

  for (const policyResult of runBuiltInPolicies(
    config.policies,
    changedFiles,
  )) {
    results.push(policyResult);
    writePolicyResult(stdout, policyResult);
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
      writeLine(stdout, `[pushgate] SKIP ${tool.name}: ${result.detail}.`);
      continue;
    }

    const command = expandChangedFilesToken(tool.command, selectedPaths);
    const commandResult = await runToolCommand(tool, command, repoRoot, env);

    if (commandResult.passed) {
      results.push({ name: tool.name, status: "passed" });
      writeLine(stdout, `[pushgate] PASS ${tool.name}.`);
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
    writeFailure(stdout, tool, result);

    if (status === "blocked" && tool.fail_fast) {
      writeLine(
        stdout,
        "[pushgate] Stopping deterministic checks after blocking failure because fail_fast is true.",
      );
      break;
    }
  }

  const blockedCount = results.filter((result) => result.status === "blocked")
    .length;
  const warningCount = results.filter((result) => result.status === "warning")
    .length;

  writeLine(
    stdout,
    `[pushgate] Deterministic checks finished: ${String(blockedCount)} blocking failure(s), ${String(warningCount)} warning(s).`,
  );

  if (blockedCount > 0) {
    writeLine(
      stdout,
      "[pushgate] Fix the blocking command failures before pushing, or use git push --no-verify to bypass local hooks intentionally.",
    );
  }

  return { exitCode: blockedCount > 0 ? 1 : 0, results };
}

export function expandChangedFilesToken(
  command: readonly string[],
  changedFilePaths: readonly string[],
): string[] {
  return command.flatMap((token) =>
    token === CHANGED_FILES_TOKEN ? [...changedFilePaths] : [token],
  );
}

async function runToolCommand(
  tool: ToolConfig,
  command: readonly string[],
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<ToolCommandResult> {
  const [executable, ...args] = command;

  if (!executable) {
    return {
      passed: false,
      detail: "command was empty",
    };
  }

  const commandResult = await runTimedCommand({
    args,
    command: executable,
    cwd: repoRoot,
    env,
    killGraceMs: TIMEOUT_KILL_GRACE_MS,
    outputCaptureLimit: OUTPUT_CAPTURE_LIMIT,
    outputTailLimit: OUTPUT_TAIL_LIMIT,
    timeoutSeconds: tool.timeout_seconds,
  });

  if (commandResult.kind === "spawn-error") {
    return {
      passed: false,
      detail: `failed to start: ${commandResult.error.message}`,
      outputTail: commandResult.outputTail,
    };
  }

  if (commandResult.kind === "timeout") {
    return {
      passed: false,
      detail: `timed out after ${String(tool.timeout_seconds)}s`,
      outputTail: commandResult.outputTail,
    };
  }

  if (commandResult.code === 0) {
    return { passed: true };
  }

  return {
    passed: false,
    detail:
      commandResult.code === null
        ? `ended by signal ${commandResult.signal ?? "unknown"}`
        : `exited with code ${String(commandResult.code)}`,
    outputTail: commandResult.outputTail,
  };
}

function writeFailure(
  stdout: NodeJS.WritableStream,
  tool: ToolConfig,
  result: ToolResult,
): void {
  const label = result.status === "warning" ? "WARN" : "BLOCK";

  writeLine(
    stdout,
    `[pushgate] ${label} ${tool.name}: ${result.detail ?? "command failed"}.`,
  );

  if (result.outputTail) {
    writeLine(stdout, "[pushgate] Command output:");

    for (const line of result.outputTail.split("\n")) {
      writeLine(stdout, `[pushgate]   ${line}`);
    }
  }
}

function writePolicyResult(
  stdout: NodeJS.WritableStream,
  result: BuiltInPolicyResult,
): void {
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
}

function writeLine(stream: NodeJS.WritableStream, line: string): void {
  stream.write(`${line}\n`);
}

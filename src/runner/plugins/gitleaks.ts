import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GitleaksPluginConfig } from "../../config/index.js";
import type { ChangedFileResolution } from "../../path-policy/index.js";
import { runTimedCommand } from "../../process/timed-command.js";

export interface GitleaksPluginResult {
  passed: boolean;
  detail?: string;
  outputTail?: string;
}

interface GitleaksFinding {
  Description?: unknown;
  File?: unknown;
  Fingerprint?: unknown;
  Line?: unknown;
  RuleID?: unknown;
  StartLine?: unknown;
}

interface ParsedGitleaksReport {
  findings: GitleaksFinding[];
  parseError?: string;
}

const OUTPUT_CAPTURE_LIMIT = 64 * 1024;
const OUTPUT_TAIL_LIMIT = 4 * 1024;
const TIMEOUT_KILL_GRACE_MS = 1_000;
const FINDING_DETAIL_LIMIT = 5;

export async function runGitleaksPlugin(
  plugin: GitleaksPluginConfig,
  changedFileResolution: ChangedFileResolution,
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<GitleaksPluginResult> {
  const tempDir = await mkdtemp(join(tmpdir(), "pushgate-gitleaks-"));
  const reportPath = join(tempDir, "report.json");

  try {
    const commandResult = await runTimedCommand({
      args: buildGitleaksArgs(plugin, changedFileResolution, repoRoot, reportPath),
      command: plugin.command,
      cwd: repoRoot,
      env,
      killGraceMs: TIMEOUT_KILL_GRACE_MS,
      outputCaptureLimit: OUTPUT_CAPTURE_LIMIT,
      outputTailLimit: OUTPUT_TAIL_LIMIT,
      timeoutSeconds: plugin.timeout_seconds,
    });

    if (commandResult.kind === "spawn-error") {
      return {
        passed: false,
        detail: `failed to start Gitleaks: ${commandResult.error.message}`,
        outputTail: commandResult.outputTail,
      };
    }

    if (commandResult.kind === "timeout") {
      return {
        passed: false,
        detail: `Gitleaks timed out after ${String(plugin.timeout_seconds)}s`,
        outputTail: commandResult.outputTail,
      };
    }

    const report = await readGitleaksReport(reportPath);

    if (report.findings.length > 0) {
      return {
        passed: false,
        detail: formatFindingDetail(report.findings),
        outputTail: commandResult.outputTail,
      };
    }

    if (commandResult.code === 0) {
      return { passed: true };
    }

    return {
      passed: false,
      detail: formatCommandFailure(commandResult, report),
      outputTail: commandResult.outputTail,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function buildGitleaksArgs(
  plugin: GitleaksPluginConfig,
  changedFileResolution: ChangedFileResolution,
  repoRoot: string,
  reportPath: string,
): string[] {
  const args = [
    "git",
    "--no-banner",
    "--no-color",
    "--redact",
    "--report-format",
    "json",
    "--report-path",
    reportPath,
    "--exit-code",
    "1",
    "--timeout",
    String(plugin.timeout_seconds),
    "--log-opts",
    changedFileResolution.scanRange,
  ];

  if (!plugin.redact) {
    args.splice(args.indexOf("--redact"), 1);
  }

  if (plugin.config_path) {
    args.push("--config", plugin.config_path);
  }

  if (plugin.baseline_path) {
    args.push("--baseline-path", plugin.baseline_path);
  }

  if (plugin.gitleaks_ignore_path) {
    args.push("--gitleaks-ignore-path", plugin.gitleaks_ignore_path);
  }

  if (plugin.max_decode_depth !== undefined) {
    args.push("--max-decode-depth", String(plugin.max_decode_depth));
  }

  if (plugin.max_archive_depth !== undefined) {
    args.push("--max-archive-depth", String(plugin.max_archive_depth));
  }

  if (plugin.max_target_megabytes !== undefined) {
    args.push("--max-target-megabytes", String(plugin.max_target_megabytes));
  }

  for (const ruleId of plugin.enable_rules ?? []) {
    args.push("--enable-rule", ruleId);
  }

  args.push(repoRoot);

  return args;
}

async function readGitleaksReport(
  reportPath: string,
): Promise<ParsedGitleaksReport> {
  let source: string;

  try {
    source = await readFile(reportPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return { findings: [] };
    }

    throw error;
  }

  if (source.trim() === "") {
    return { findings: [] };
  }

  try {
    const parsed: unknown = JSON.parse(source);

    if (!Array.isArray(parsed)) {
      return {
        findings: [],
        parseError: "Gitleaks JSON report was not an array",
      };
    }

    return {
      findings: parsed.filter(isGitleaksFinding),
    };
  } catch (error) {
    return {
      findings: [],
      parseError:
        error instanceof Error
          ? `could not parse Gitleaks JSON report: ${error.message}`
          : "could not parse Gitleaks JSON report",
    };
  }
}

function isGitleaksFinding(value: unknown): value is GitleaksFinding {
  return value !== null && typeof value === "object";
}

function isMissingFileError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function formatFindingDetail(findings: readonly GitleaksFinding[]): string {
  const formatted = findings
    .slice(0, FINDING_DETAIL_LIMIT)
    .map(formatFinding)
    .join(", ");
  const remaining = findings.length - FINDING_DETAIL_LIMIT;
  const suffix = remaining > 0 ? `, ${String(remaining)} more` : "";

  return [
    `Gitleaks found ${String(findings.length)} potential secret leak(s):`,
    `${formatted}${suffix}; rotate exposed credentials before pushing`,
    "and use a Gitleaks baseline or .gitleaksignore only for verified false positives",
  ].join(" ");
}

function formatFinding(finding: GitleaksFinding): string {
  const path = stringValue(finding.File) ?? "unknown file";
  const line = numberValue(finding.StartLine) ?? numberValue(finding.Line);
  const rule =
    stringValue(finding.RuleID) ??
    stringValue(finding.Description) ??
    stringValue(finding.Fingerprint) ??
    "unknown rule";

  return `${path}${line === undefined ? "" : `:${String(line)}`} (${rule})`;
}

function formatCommandFailure(
  commandResult: Extract<
    Awaited<ReturnType<typeof runTimedCommand>>,
    { kind: "completed" }
  >,
  report: ParsedGitleaksReport,
): string {
  const exitDetail =
    commandResult.code === null
      ? `Gitleaks ended by signal ${commandResult.signal ?? "unknown"}`
      : `Gitleaks exited with code ${String(commandResult.code)}`;

  return report.parseError ? `${exitDetail}; ${report.parseError}` : exitDetail;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

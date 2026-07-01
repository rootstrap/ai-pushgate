import ignore from "ignore";

import type {
  BuiltInPoliciesConfig,
  BuiltInPolicyMode,
  DiffSizePolicyConfig,
  ForbiddenPathsPolicyConfig,
} from "../config/index.js";
import {
  countChangedTextLines,
  selectLiveChangedFiles,
  type ChangedFile,
} from "../path-policy/index.js";

export type BuiltInPolicyResultStatus = "passed" | "warning" | "blocked";

export interface BuiltInPolicyResult {
  name: string;
  status: BuiltInPolicyResultStatus;
  detail?: string;
}

interface ForbiddenPathMatch {
  path: string;
  pattern: string;
}

const FORBIDDEN_PATH_DETAIL_LIMIT = 5;

export function countBuiltInPolicies(
  policies: BuiltInPoliciesConfig,
): number {
  return (
    Number(Boolean(policies.diff_size)) +
    Number(Boolean(policies.forbidden_paths))
  );
}

export function runBuiltInPolicies(
  policies: BuiltInPoliciesConfig,
  changedFiles: readonly ChangedFile[],
): BuiltInPolicyResult[] {
  const results: BuiltInPolicyResult[] = [];

  if (policies.diff_size) {
    results.push(runDiffSizePolicy(policies.diff_size, changedFiles));
  }

  if (policies.forbidden_paths) {
    results.push(
      runForbiddenPathsPolicy(policies.forbidden_paths, changedFiles),
    );
  }

  return results;
}

function runDiffSizePolicy(
  policy: DiffSizePolicyConfig,
  changedFiles: readonly ChangedFile[],
): BuiltInPolicyResult {
  const changedLines = countChangedTextLines(changedFiles);

  if (changedLines <= policy.max_changed_lines) {
    return {
      name: "policy:diff_size",
      status: "passed",
      detail: `${String(changedLines)} changed line(s) within max_changed_lines ${String(policy.max_changed_lines)}`,
    };
  }

  return violationResult(
    policy.mode,
    "policy:diff_size",
    [
      `${String(changedLines)} changed line(s) exceed max_changed_lines`,
      `${String(policy.max_changed_lines)}; split the push or raise`,
      "policies.diff_size.max_changed_lines if this is intentional",
    ].join(" "),
  );
}

function runForbiddenPathsPolicy(
  policy: ForbiddenPathsPolicyConfig,
  changedFiles: readonly ChangedFile[],
): BuiltInPolicyResult {
  const matches = selectLiveChangedFiles(changedFiles)
    .flatMap((file) => {
      const pattern = firstMatchingPattern(policy.patterns, file.path);

      return pattern ? [{ path: file.path, pattern }] : [];
    });

  if (matches.length === 0) {
    return {
      name: "policy:forbidden_paths",
      status: "passed",
      detail: "no changed live paths match forbidden patterns",
    };
  }

  return violationResult(
    policy.mode,
    "policy:forbidden_paths",
    [
      `${String(matches.length)} changed path(s) match forbidden patterns:`,
      `${formatForbiddenPathMatches(matches)}; remove them from the push`,
      "or update policies.forbidden_paths.patterns if this is intentional",
    ].join(" "),
  );
}

function firstMatchingPattern(
  patterns: readonly string[],
  path: string,
): string | undefined {
  return patterns.find((pattern) => ignore().add(pattern).ignores(path));
}

function formatForbiddenPathMatches(
  matches: readonly ForbiddenPathMatch[],
): string {
  const formatted = matches
    .slice(0, FORBIDDEN_PATH_DETAIL_LIMIT)
    .map((match) => `${match.path} (${match.pattern})`);
  const remaining = matches.length - formatted.length;

  if (remaining > 0) {
    formatted.push(`${String(remaining)} more`);
  }

  return formatted.join(", ");
}

function violationResult(
  mode: BuiltInPolicyMode,
  name: string,
  detail: string,
): BuiltInPolicyResult {
  return {
    detail,
    name,
    status: mode === "warning" ? "warning" : "blocked",
  };
}

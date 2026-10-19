import { readGitStringConfig } from "../git/config.js";
import { runGit } from "../git/command.js";
import type {
  PrePushBranchUpdate,
  PrePushHookContext,
} from "./pre-push-hook-context.js";
import {
  createInteractiveTerminal,
  InteractiveTerminalError,
  type InteractiveTerminal,
  type InteractiveTerminalChoice,
} from "./terminal.js";

export const REVIEW_TARGET_CONFIG_KEY = "pushgate.review-target" as const;

export type ReviewTargetCandidateSource =
  | "configured"
  | "custom"
  | "incremental"
  | "stacked"
  | "target-remote";

export interface ReviewTargetCandidate {
  detail?: string;
  label: string;
  ref: string;
  recommended?: boolean;
  source: ReviewTargetCandidateSource;
}

export interface ReviewTargetDiagnostic {
  level: "info" | "warning";
  message: string;
  tip?: string;
}

export interface ReviewTargetSelectionPrompt {
  candidates: readonly ReviewTargetCandidate[];
  diagnostics: readonly ReviewTargetDiagnostic[];
}

export type ReviewTargetSelector = (
  request: ReviewTargetSelectionPrompt,
) => Promise<ReviewTargetCandidate>;

export interface SelectedReviewTarget {
  diagnostics: readonly ReviewTargetDiagnostic[];
  label: string;
  prompted: boolean;
  ref: string;
  source: ReviewTargetCandidateSource | "override";
}

export interface SelectReviewTargetOptions {
  configuredTargetRef: string;
  env: NodeJS.ProcessEnv;
  hookContext: PrePushHookContext;
  onDiagnostics?: (diagnostics: readonly ReviewTargetDiagnostic[]) => void;
  repoRoot: string;
  selector?: ReviewTargetSelector;
}

interface CandidateWithCommit extends ReviewTargetCandidate {
  commit?: string;
}

interface StackedCandidateWithDistance extends CandidateWithCommit {
  detail: string;
  distance: number;
}

type TargetFreshness = "ahead" | "behind" | "diverged" | "missing" | "same";

const MAX_STACKED_CANDIDATES = 3;
const MAX_STACKED_DISTANCE_CANDIDATES = 25;
const FULL_OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const ZERO_OBJECT = /^0+$/;

export class ReviewTargetSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export async function selectReviewTarget(
  options: SelectReviewTargetOptions,
): Promise<SelectedReviewTarget> {
  if (options.hookContext.branchUpdates.length > 1) {
    throw new ReviewTargetSelectionError(
      "Pushgate cannot choose one review target for a push that updates multiple branches. Push one branch at a time.",
    );
  }

  const overrideRef = await readGitStringConfig(
    options.repoRoot,
    REVIEW_TARGET_CONFIG_KEY,
    options.env,
    { preserveGitConfigOverlay: true },
  );
  const discovery = await discoverReviewTargets(options);

  options.onDiagnostics?.(discovery.diagnostics);

  if (overrideRef) {
    if (!(await resolveCommit(options.repoRoot, overrideRef))) {
      throw new ReviewTargetSelectionError(
        `One-push override ${REVIEW_TARGET_CONFIG_KEY}="${overrideRef}" cannot be resolved locally. Check the ref and retry.`,
      );
    }

    return {
      diagnostics: discovery.diagnostics,
      label: overrideRef,
      prompted: false,
      ref: overrideRef,
      source: "override",
    };
  }

  if (!discovery.promptRequired) {
    const configured = discovery.candidates.find(
      (candidate) => candidate.source === "configured",
    );

    if (!configured) {
      throw new ReviewTargetSelectionError(
        "Pushgate could not prepare the configured review target.",
      );
    }

    return {
      diagnostics: discovery.diagnostics,
      label: configured.label,
      prompted: false,
      ref: configured.ref,
      source: configured.source,
    };
  }

  const selector = options.selector ?? createTerminalReviewTargetSelector();
  const selected = await selector({
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });

  return {
    diagnostics: discovery.diagnostics,
    label: selected.label,
    prompted: true,
    ref: selected.ref,
    source: selected.source,
  };
}

export function createTerminalReviewTargetSelector(
  options: { terminal?: InteractiveTerminal } = {},
): ReviewTargetSelector {
  const terminal = options.terminal ?? createInteractiveTerminal();

  return async (request) => {
    if (!terminal.choose || !terminal.prompt) {
      throw new ReviewTargetSelectionError(noInteractiveTerminalMessage());
    }

    try {
      const choices: InteractiveTerminalChoice[] = request.candidates.map(
        (candidate) => ({
          detail: candidate.detail,
          label: candidate.recommended
            ? `${candidate.label} (recommended)`
            : candidate.label,
        }),
      );
      choices.push({
        detail: "advanced",
        label: "Enter another ref",
      });

      const selectedIndex = terminal.choose("Choose review target", choices);

      if (selectedIndex < request.candidates.length) {
        const selected = request.candidates[selectedIndex];

        if (!selected) {
          throw new ReviewTargetSelectionError(
            "Pushgate could not read the selected review target.",
          );
        }

        return selected;
      }

      const customRef = terminal.prompt("Review target ref:").trim();

      if (!customRef) {
        throw new ReviewTargetSelectionError(
          "Pushgate needs a non-empty review target ref.",
        );
      }

      return {
        label: customRef,
        ref: customRef,
        source: "custom",
      };
    } catch (error) {
      if (error instanceof ReviewTargetSelectionError) {
        throw error;
      }

      if (error instanceof InteractiveTerminalError) {
        throw new ReviewTargetSelectionError(noInteractiveTerminalMessage());
      }

      throw error;
    }
  };
}

async function discoverReviewTargets(options: SelectReviewTargetOptions): Promise<{
  candidates: ReviewTargetCandidate[];
  diagnostics: ReviewTargetDiagnostic[];
  promptRequired: boolean;
}> {
  const diagnostics: ReviewTargetDiagnostic[] = [];
  const configuredTarget = await candidateForRef({
    repoRoot: options.repoRoot,
    detail: "configured review.target_branch",
    label: options.configuredTargetRef,
    ref: options.configuredTargetRef,
    source: "configured",
  });
  const targetRemoteRef = await resolveTargetRemoteRef({
    configuredTargetRef: options.configuredTargetRef,
    pushRemote: options.hookContext.remote,
    repoRoot: options.repoRoot,
  });
  const targetRemote =
    targetRemoteRef && targetRemoteRef !== options.configuredTargetRef
      ? await candidateForRef({
          repoRoot: options.repoRoot,
          detail: "latest fetched target remote",
          label: targetRemoteRef,
          ref: targetRemoteRef,
          source: "target-remote",
        })
      : null;
  const resolvedTargetRemote = targetRemote?.commit ? targetRemote : null;
  const freshness =
    configuredTarget.commit && resolvedTargetRemote?.commit
      ? await compareCommits(
          options.repoRoot,
          configuredTarget.commit,
          resolvedTargetRemote.commit,
        )
      : "missing";
  const branchUpdate =
    options.hookContext.branchUpdates.length === 1
      ? options.hookContext.branchUpdates[0]
      : undefined;
  const currentBranch = branchUpdate
    ? branchUpdate.localBranch
    : await resolveCurrentBranch(options.repoRoot);
  const fallbackCurrentRemoteRef =
    !branchUpdate && currentBranch && options.hookContext.remote
      ? `${options.hookContext.remote}/${currentBranch}`
      : undefined;
  const incremental = branchUpdate
    ? (await incrementalCandidateFromPrePush(options.repoRoot, branchUpdate)) ??
      (await incrementalCandidateFromRemoteTrackingRef({
        currentBranch,
        currentRemoteRef: remoteTrackingRefForUpdate(
          options.hookContext.remote,
          branchUpdate,
        ),
        repoRoot: options.repoRoot,
      }))
    : await incrementalCandidateFromRemoteTrackingRef({
        currentBranch,
        currentRemoteRef: fallbackCurrentRemoteRef,
        repoRoot: options.repoRoot,
      });
  const stacked = await findStackedCandidates({
    currentRemoteRef: branchUpdate
      ? remoteTrackingRefForUpdate(options.hookContext.remote, branchUpdate)
      : fallbackCurrentRemoteRef,
    repoRoot: options.repoRoot,
    targetRemoteRef: resolvedTargetRemote?.ref,
  });
  const promptRequired =
    freshness === "behind" ||
    freshness === "diverged" ||
    incremental !== null ||
    stacked.length > 0;

  appendFreshnessDiagnostic({
    configuredTargetRef: options.configuredTargetRef,
    diagnostics,
    freshness,
    promptRequired,
    pushRemote: options.hookContext.remote,
    targetRemoteRef: resolvedTargetRemote?.ref,
  });

  const candidatePool = [
    configuredTarget,
    resolvedTargetRemote,
    incremental,
    ...stacked,
  ];
  const recommended = recommendedCandidate({
    candidates: candidatePool,
    freshness,
  });
  const candidates = dedupeCandidatesByCommit(candidatePool).map((candidate) => ({
    ...candidate,
    recommended: candidate === recommended,
  }));

  return {
    candidates,
    diagnostics,
    promptRequired,
  };
}

async function candidateForRef(
  options: ReviewTargetCandidate & { repoRoot: string },
): Promise<CandidateWithCommit> {
  return {
    detail: options.detail,
    label: options.label,
    recommended: options.recommended,
    ref: options.ref,
    source: options.source,
    commit: await resolveCommit(options.repoRoot, options.ref),
  };
}

async function resolveCommit(
  repoRoot: string,
  ref: string,
): Promise<string | undefined> {
  const result = await runGit(repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);

  return result.code === 0 ? result.stdout.trim() : undefined;
}

async function resolveTargetRemoteRef(options: {
  configuredTargetRef: string;
  pushRemote: string | undefined;
  repoRoot: string;
}): Promise<string | null> {
  const upstreamResult = await runGit(options.repoRoot, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    `${options.configuredTargetRef}@{upstream}`,
  ]);

  if (upstreamResult.code === 0) {
    const upstream = upstreamResult.stdout.trim();

    if (upstream) {
      return upstream;
    }
  }

  if (
    !options.pushRemote ||
    isRemoteRefForPushRemote(options.configuredTargetRef, options.pushRemote) ||
    !isSimpleBranchName(options.configuredTargetRef)
  ) {
    return null;
  }

  return `${options.pushRemote}/${options.configuredTargetRef}`;
}

async function compareCommits(
  repoRoot: string,
  localCommit: string,
  remoteCommit: string,
): Promise<TargetFreshness> {
  if (localCommit === remoteCommit) {
    return "same";
  }

  const [localIsAncestor, remoteIsAncestor] = await Promise.all([
    isAncestor(repoRoot, localCommit, remoteCommit),
    isAncestor(repoRoot, remoteCommit, localCommit),
  ]);

  if (localIsAncestor) {
    return "behind";
  }

  if (remoteIsAncestor) {
    return "ahead";
  }

  return "diverged";
}

function appendFreshnessDiagnostic(options: {
  configuredTargetRef: string;
  diagnostics: ReviewTargetDiagnostic[];
  freshness: TargetFreshness;
  promptRequired: boolean;
  pushRemote: string | undefined;
  targetRemoteRef: string | undefined;
}): void {
  if (!options.targetRemoteRef) {
    return;
  }

  if (options.freshness === "behind") {
    options.diagnostics.push({
      level: "warning",
      message: `${options.configuredTargetRef} is behind ${options.targetRemoteRef}. Pushgate may review against stale code.`,
      tip: fetchTip(options.pushRemote, options.configuredTargetRef),
    });
    return;
  }

  if (options.freshness === "diverged") {
    options.diagnostics.push({
      level: "warning",
      message: `${options.configuredTargetRef} has diverged from ${options.targetRemoteRef}. Pushgate may review against stale code.`,
      tip: fetchTip(options.pushRemote, options.configuredTargetRef),
    });
    return;
  }

  if (options.freshness === "ahead" && options.promptRequired) {
    options.diagnostics.push({
      level: "info",
      message: `${options.configuredTargetRef} is ahead of ${options.targetRemoteRef}. Choose ${options.configuredTargetRef} only if those local commits belong in the review target.`,
    });
  }
}

async function incrementalCandidateFromPrePush(
  repoRoot: string,
  branchUpdate: PrePushBranchUpdate,
): Promise<CandidateWithCommit | null> {
  if (
    isZeroObjectName(branchUpdate.remoteSha) ||
    !isLikelyObjectName(branchUpdate.remoteSha)
  ) {
    return null;
  }

  const commit = await resolveCommit(repoRoot, branchUpdate.remoteSha);

  if (!commit) {
    return null;
  }

  return {
    commit,
    detail: `review only commits not already on ${branchUpdate.remoteRef}`,
    label: `destination ${branchUpdate.remoteBranch ?? branchUpdate.localBranch} tip`,
    ref: commit,
    source: "incremental",
  };
}

async function incrementalCandidateFromRemoteTrackingRef(options: {
  currentBranch: string | undefined;
  currentRemoteRef: string | undefined;
  repoRoot: string;
}): Promise<CandidateWithCommit | null> {
  if (!options.currentBranch || !options.currentRemoteRef) {
    return null;
  }

  const commit = await resolveCommit(options.repoRoot, options.currentRemoteRef);

  if (!commit) {
    return null;
  }

  return {
    commit,
    detail: `review only commits not already on ${options.currentRemoteRef}`,
    label: `destination ${options.currentBranch} tip`,
    ref: commit,
    source: "incremental",
  };
}

async function findStackedCandidates(options: {
  currentRemoteRef: string | undefined;
  repoRoot: string;
  targetRemoteRef: string | undefined;
}): Promise<CandidateWithCommit[]> {
  const result = await runGit(options.repoRoot, [
    "for-each-ref",
    "--merged=HEAD",
    "--sort=-committerdate",
    "--format=%(refname:short)%00%(objectname)",
    "refs/remotes",
  ]);

  if (result.code !== 0) {
    return [];
  }

  const ancestorCandidates: CandidateWithCommit[] = [];

  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    const [ref, commit] = line.split("\0", 2);

    if (
      !ref ||
      !commit ||
      ref.endsWith("/HEAD") ||
      ref === options.currentRemoteRef ||
      ref === options.targetRemoteRef ||
      isZeroObjectName(commit)
    ) {
      continue;
    }

    ancestorCandidates.push({
      commit,
      label: ref,
      ref,
      source: "stacked",
    });

    if (ancestorCandidates.length >= MAX_STACKED_DISTANCE_CANDIDATES) {
      break;
    }
  }

  const candidatesWithDistance: Array<StackedCandidateWithDistance | null> =
    await Promise.all(
      ancestorCandidates.map(async (candidate) => {
        const distance = await commitDistance(
          options.repoRoot,
          candidate.commit ?? candidate.ref,
          "HEAD",
        );

        if (distance === null || distance === 0) {
          return null;
        }

        return {
          ...candidate,
          detail: `${String(distance)} commit(s) behind HEAD`,
          distance,
        };
      }),
    );

  return candidatesWithDistance
    .filter(
      (candidate): candidate is StackedCandidateWithDistance =>
        candidate !== null,
    )
    .sort((left, right) => left.distance - right.distance)
    .slice(0, MAX_STACKED_CANDIDATES)
    .map(({ distance: _distance, ...candidate }) => candidate);
}

function recommendedCandidate(options: {
  candidates: readonly (CandidateWithCommit | null)[];
  freshness: TargetFreshness;
}): CandidateWithCommit | null {
  const candidates = options.candidates.filter(
    (candidate): candidate is CandidateWithCommit => candidate !== null,
  );

  return (
    candidates.find((candidate) => candidate.source === "incremental") ??
    candidates.find((candidate) => candidate.source === "stacked") ??
    (options.freshness === "behind" || options.freshness === "diverged"
      ? candidates.find((candidate) => candidate.source === "target-remote")
      : undefined) ??
    candidates.find((candidate) => candidate.source === "configured") ??
    null
  );
}

function dedupeCandidatesByCommit(
  candidates: readonly (CandidateWithCommit | null)[],
): CandidateWithCommit[] {
  const deduped: CandidateWithCommit[] = [];
  const seenCommits = new Set<string>();
  const seenRefs = new Set<string>();

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const commitKey = candidate.commit;
    const refKey = candidate.ref;

    if (commitKey && seenCommits.has(commitKey)) {
      continue;
    }

    if (seenRefs.has(refKey)) {
      continue;
    }

    if (commitKey) {
      seenCommits.add(commitKey);
    }

    seenRefs.add(refKey);
    deduped.push(candidate);
  }

  return deduped;
}

function remoteTrackingRefForUpdate(
  remote: string | undefined,
  update: PrePushBranchUpdate,
): string | undefined {
  if (!remote) {
    return undefined;
  }

  const remoteBranch = update.remoteBranch ?? update.localBranch;

  return `${remote}/${remoteBranch}`;
}

async function isAncestor(
  repoRoot: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await runGit(repoRoot, [
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant,
  ]);

  return result.code === 0;
}

async function commitDistance(
  repoRoot: string,
  ancestor: string,
  descendant: string,
): Promise<number | null> {
  const result = await runGit(repoRoot, [
    "rev-list",
    "--count",
    `${ancestor}..${descendant}`,
  ]);

  if (result.code !== 0) {
    return null;
  }

  const distance = Number.parseInt(result.stdout.trim(), 10);

  return Number.isFinite(distance) ? distance : null;
}

async function resolveCurrentBranch(
  repoRoot: string,
): Promise<string | undefined> {
  const result = await runGit(repoRoot, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);

  return result.code === 0 ? result.stdout.trim() : undefined;
}

function isSimpleBranchName(ref: string): boolean {
  return (
    !ref.startsWith("refs/") &&
    !ref.includes("..") &&
    !ref.includes("@{") &&
    !ref.includes(":") &&
    !FULL_OBJECT_NAME.test(ref)
  );
}

function isRemoteRefForPushRemote(ref: string, pushRemote: string): boolean {
  return (
    ref === pushRemote ||
    ref.startsWith(`${pushRemote}/`) ||
    ref.startsWith("refs/remotes/")
  );
}

function isZeroObjectName(value: string): boolean {
  return ZERO_OBJECT.test(value);
}

function isLikelyObjectName(value: string): boolean {
  return FULL_OBJECT_NAME.test(value);
}

function fetchTip(remote: string | undefined, targetRef: string): string {
  const fetchCommand = remote ? `git fetch ${remote}` : "git fetch";

  return `Run \`${fetchCommand}\` and update \`${targetRef}\` before retrying, or choose a review target now.`;
}

function noInteractiveTerminalMessage(): string {
  return `Pushgate needs a review target selection, but no interactive terminal is available. Re-run from a terminal, set review.target_branch explicitly, or use \`git -c ${REVIEW_TARGET_CONFIG_KEY}=<ref> push\`.`;
}

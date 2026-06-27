import { runInheritedCommand } from "../process/inherited-command.js";
import { runCommand } from "../process/run-command.js";

export interface GitPushResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface GitPushSuccessSummary {
  pullRequestUrl?: string;
  upstream?: string;
}

interface ParsedGitPushArgs {
  branch?: string;
  remote?: string;
  setsUpstream: boolean;
}

export function runGitPush(
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
  },
): Promise<GitPushResult> {
  return runInheritedCommand({
    args,
    command: "git",
    env: options.env,
  });
}

export async function resolveGitPushSuccessSummary(
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
  },
): Promise<GitPushSuccessSummary> {
  const parsed = parseGitPushArgs(args);
  const currentUpstream = parsed.setsUpstream
    ? await readCurrentUpstream(options.env)
    : undefined;
  const branch =
    parsed.branch ??
    branchFromUpstream(currentUpstream) ??
    (await readCurrentBranch(options.env));
  const remote =
    parsed.remote ??
    remoteFromUpstream(currentUpstream) ??
    (branch ? await readConfiguredBranchRemote(branch, options.env) : undefined);
  const upstream = parsed.setsUpstream
    ? currentUpstream ?? upstreamFromParts(remote, branch)
    : undefined;
  const remoteUrl = remote ? await readRemoteUrl(remote, options.env) : undefined;

  return {
    pullRequestUrl:
      remoteUrl && branch
        ? githubPullRequestUrl(remoteUrl, branch)
        : undefined,
    upstream,
  };
}

export function formatGitPushSuccessSummary(
  summary: GitPushSuccessSummary,
): string {
  const rows = ["  [ok] Branch pushed"];

  if (summary.upstream) {
    rows.push(`  [ok] Upstream set: ${summary.upstream}`);
  }

  let output = `\nPushing branch\n${rows.join("\n")}\n`;

  if (summary.pullRequestUrl) {
    output += `\nCreate a pull request:\n  ${summary.pullRequestUrl}\n`;
  }

  return output;
}

function parseGitPushArgs(args: readonly string[]): ParsedGitPushArgs {
  const positionals: string[] = [];
  let parseOptions = true;
  let setsUpstream = false;
  let skipNext = false;

  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (parseOptions && arg === "--") {
      parseOptions = false;
      continue;
    }

    if (parseOptions && (arg === "-u" || arg === "--set-upstream")) {
      setsUpstream = true;
      continue;
    }

    if (parseOptions && arg.startsWith("-")) {
      skipNext = optionTakesSeparateValue(arg);
      continue;
    }

    positionals.push(arg);
  }

  return {
    branch: positionals[1] ? branchFromRefspec(positionals[1]) : undefined,
    remote: positionals[0],
    setsUpstream,
  };
}

function optionTakesSeparateValue(arg: string): boolean {
  return (
    arg === "--exec" ||
    arg === "--receive-pack" ||
    arg === "--repo" ||
    arg === "--push-option" ||
    arg === "-o"
  );
}

function branchFromRefspec(refspec: string): string | undefined {
  let branch = refspec.trim();

  if (!branch || branch.includes("*")) {
    return undefined;
  }

  if (branch.startsWith("+")) {
    branch = branch.slice(1);
  }

  const remoteBranchSeparator = branch.lastIndexOf(":");
  if (remoteBranchSeparator >= 0) {
    branch = branch.slice(remoteBranchSeparator + 1);
  }

  if (!branch || branch === "HEAD") {
    return undefined;
  }

  if (branch.startsWith("refs/heads/")) {
    return branch.slice("refs/heads/".length);
  }

  if (branch.startsWith("refs/")) {
    return undefined;
  }

  return branch;
}

async function readCurrentBranch(
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const branch = await readGitStdout(["rev-parse", "--abbrev-ref", "HEAD"], env);

  if (!branch || branch === "HEAD") {
    return undefined;
  }

  return branch;
}

async function readCurrentUpstream(
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  return readGitStdout(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    env,
  );
}

async function readConfiguredBranchRemote(
  branch: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  return readGitStdout(["config", "--get", `branch.${branch}.remote`], env);
}

async function readRemoteUrl(
  remote: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  return readGitStdout(["remote", "get-url", remote], env);
}

async function readGitStdout(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const result = await runCommand({
      args,
      command: "git",
      env,
    });

    if (result.code !== 0) {
      return undefined;
    }

    const output = result.stdout.trim();

    return output ? output : undefined;
  } catch {
    return undefined;
  }
}

function upstreamFromParts(
  remote: string | undefined,
  branch: string | undefined,
): string | undefined {
  return remote && branch ? `${remote}/${branch}` : undefined;
}

function remoteFromUpstream(upstream: string | undefined): string | undefined {
  const separator = upstream?.indexOf("/") ?? -1;

  return separator > 0 ? upstream?.slice(0, separator) : undefined;
}

function branchFromUpstream(upstream: string | undefined): string | undefined {
  const separator = upstream?.indexOf("/") ?? -1;

  return separator > 0 ? upstream?.slice(separator + 1) : undefined;
}

function githubPullRequestUrl(
  remoteUrl: string,
  branch: string,
): string | undefined {
  const repository = githubRepository(remoteUrl);

  if (!repository) {
    return undefined;
  }

  return `https://github.com/${repository.owner}/${repository.repo}/pull/new/${encodeURIComponent(
    branch,
  )}`;
}

function githubRepository(
  remoteUrl: string,
): { owner: string; repo: string } | undefined {
  const trimmed = remoteUrl.trim();
  const sshMatch = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(
    trimmed,
  );

  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2],
    };
  }

  try {
    const parsed = new URL(trimmed);

    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.toLowerCase() !== "github.com"
    ) {
      return undefined;
    }

    const pathParts = parsed.pathname.replace(/^\/|\/$/g, "").split("/");

    if (pathParts.length !== 2) {
      return undefined;
    }

    const [owner, repoWithPossibleSuffix] = pathParts;
    const repo = repoWithPossibleSuffix.endsWith(".git")
      ? repoWithPossibleSuffix.slice(0, -".git".length)
      : repoWithPossibleSuffix;

    return owner && repo ? { owner, repo } : undefined;
  } catch {
    return undefined;
  }
}

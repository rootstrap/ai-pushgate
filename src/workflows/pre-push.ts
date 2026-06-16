import { runLocalAiReview } from "../ai/index.js";
import { loadConfig, type PushgateConfig } from "../config/index.js";
import { resolveGitRepositoryRoot } from "../git/repository.js";
import {
  resolveChangedFiles,
  type ChangedFileResolution,
} from "../path-policy/index.js";
import { runDeterministicChecks } from "../runner/deterministic.js";
import { countBuiltInPolicies } from "../runner/policies.js";
import {
  resolveSkipControlState,
  type SkipControlState,
} from "../skip-controls.js";

export interface PrePushWorkflowIO {
  env: NodeJS.ProcessEnv;
  stderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
}

export async function runPrePushWorkflow(
  io: PrePushWorkflowIO,
): Promise<number> {
  await drainStdin(io.stdin);

  const repoRoot = await resolveGitRepositoryRoot(io.env);
  const skipControls = await resolveSkipControlState(repoRoot, io.env);

  if (skipControls.skipAllChecks) {
    io.stdout.write(
      "[pushgate] Skipping all local Pushgate checks because pushgate.skip-all-checks=true.\n",
    );
    return 0;
  }

  const loaded = await loadConfig(repoRoot);

  for (const warning of loaded.warnings) {
    io.stdout.write(`[pushgate] Warning: ${warning}\n`);
  }

  const changedFileResolution = await maybeResolveChangedFiles(loaded.config, {
    repoRoot,
    skipControls,
  });

  const summary = await runDeterministicPhase(
    loaded.config,
    changedFileResolution,
    {
      env: io.env,
      repoRoot,
      stderr: io.stderr,
      stdout: io.stdout,
    },
  );

  if (summary.exitCode !== 0) {
    return summary.exitCode;
  }

  return await runLocalAiPhase(
    loaded.config,
    changedFileResolution,
    skipControls,
    {
      env: io.env,
      repoRoot,
      stdout: io.stdout,
    },
  );
}

async function runDeterministicPhase(
  config: PushgateConfig,
  changedFileResolution: ChangedFileResolution | null,
  options: {
    env: NodeJS.ProcessEnv;
    repoRoot: string;
    stderr: NodeJS.WritableStream;
    stdout: NodeJS.WritableStream;
  },
) {
  if (
    config.tools.length === 0 &&
    countBuiltInPolicies(config.policies) === 0
  ) {
    return runDeterministicChecks(config, [], options);
  }

  return runDeterministicChecks(
    config,
    changedFileResolution?.files ?? [],
    options,
  );
}

async function runLocalAiPhase(
  config: PushgateConfig,
  changedFileResolution: ChangedFileResolution | null,
  skipControls: SkipControlState,
  options: {
    env: NodeJS.ProcessEnv;
    repoRoot: string;
    stdout: NodeJS.WritableStream;
  },
): Promise<number> {
  if (config.ai.mode === "off") {
    return 0;
  }

  if (skipControls.skipAiCheck) {
    options.stdout.write(
      "[pushgate] Skipping local AI because pushgate.skip-ai-check=true.\n",
    );
    return 0;
  }

  if (changedFileResolution === null) {
    throw new Error(
      "Pushgate could not prepare changed files for the local AI phase.",
    );
  }

  return (
    await runLocalAiReview({
      aiConfig: config.ai,
      changedFileResolution,
      env: options.env,
      repoRoot: options.repoRoot,
      reviewConfig: config.review,
      stdout: options.stdout,
    })
  ).exitCode;
}

async function maybeResolveChangedFiles(
  config: PushgateConfig,
  options: {
    repoRoot: string;
    skipControls: SkipControlState;
  },
): Promise<ChangedFileResolution | null> {
  const deterministicCheckCount =
    config.tools.length + countBuiltInPolicies(config.policies);
  const shouldRunAi =
    config.ai.mode !== "off" && !options.skipControls.skipAiCheck;

  if (deterministicCheckCount === 0 && !shouldRunAi) {
    return null;
  }

  return await resolveChangedFiles({
    repoRoot: options.repoRoot,
    targetBranch: config.review.target_branch,
    ignorePaths: config.ignore_paths,
  });
}

function drainStdin(stdin: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((stdin as { isTTY?: boolean }).isTTY) {
      resolve();
      return;
    }

    stdin.on("error", reject);
    stdin.on("end", resolve);
    stdin.resume();
  });
}

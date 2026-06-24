import { runLocalAiReview } from "../ai/index.js";
import { loadConfig, type PushgateConfig } from "../config/index.js";
import { resolveGitRepositoryRoot } from "../git/repository.js";
import {
  resolveChangedFiles,
  type ChangedFileResolution,
} from "../path-policy/index.js";
import { runDeterministicChecks } from "../runner/deterministic.js";
import { resolveSkipControlState } from "../skip-controls.js";
import {
  buildPrePushRunPlan,
  type PrePushRunPlan,
} from "./run-plan.js";

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

  const runPlan = buildPrePushRunPlan(loaded.config, skipControls);
  const changedFileResolution = await maybeResolveChangedFiles(loaded.config, {
    repoRoot,
    runPlan,
  });

  const summary = await runDeterministicChecks({
    changedFileResolution,
    config: loaded.config,
    env: io.env,
    repoRoot,
    stdout: io.stdout,
  });

  if (summary.exitCode !== 0) {
    return summary.exitCode;
  }

  return await runLocalAiPhase(
    loaded.config,
    runPlan,
    changedFileResolution,
    {
      env: io.env,
      repoRoot,
      stdout: io.stdout,
    },
  );
}

async function runLocalAiPhase(
  config: PushgateConfig,
  runPlan: PrePushRunPlan,
  changedFileResolution: ChangedFileResolution | null,
  options: {
    env: NodeJS.ProcessEnv;
    repoRoot: string;
    stdout: NodeJS.WritableStream;
  },
): Promise<number> {
  if (runPlan.localAiSkipReason === "mode-off") {
    return 0;
  }

  if (runPlan.localAiSkipReason === "skip-control") {
    options.stdout.write(
      "[pushgate] Skipping local AI because pushgate.skip-ai-check=true.\n",
    );
    return 0;
  }

  return (
    await runLocalAiReview({
      aiConfig: config.ai,
      changedFileResolution: requireChangedFileResolution(
        changedFileResolution,
        "local AI phase",
      ),
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
    runPlan: PrePushRunPlan;
  },
): Promise<ChangedFileResolution | null> {
  if (!options.runPlan.needsChangedFiles) {
    return null;
  }

  return await resolveChangedFiles({
    repoRoot: options.repoRoot,
    targetBranch: config.review.target_branch,
    ignorePaths: config.ignore_paths,
  });
}

function requireChangedFileResolution(
  changedFileResolution: ChangedFileResolution | null,
  phaseName: string,
): ChangedFileResolution {
  if (changedFileResolution !== null) {
    return changedFileResolution;
  }

  throw new Error(
    `Pushgate could not prepare changed files for the ${phaseName}.`,
  );
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

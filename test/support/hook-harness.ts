import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sanitizeGitLocalEnv } from "../../src/git/environment.js";

/** Captured process result returned to harness tests instead of throwing. */
export interface CommandResult {
  /** Exit code from the child process, or `null` when a signal ended it. */
  code: number | null;
  /** Signal that ended the child process, or `null` for normal completion. */
  signal: NodeJS.Signals | null;
  /** Standard error captured as UTF-8 text. */
  stderr: string;
  /** Standard output captured as UTF-8 text. */
  stdout: string;
}

/** Overrides available when a test invokes Git or the repository hook. */
export interface HookRunOptions {
  /** Hook arguments to append after the hook path. */
  args?: string[];
  /** Environment overrides layered over the isolated harness environment. */
  env?: NodeJS.ProcessEnv;
  /** Standard input delivered to the spawned process. */
  stdin?: string;
}

/** Controls for the managed runner stub used by hook boundary tests. */
export interface RunnerStubOptions {
  /** Leave the stub without execute bits when testing hook diagnostics. */
  executable?: boolean;
}

/**
 * Disposable Git workspace used to exercise the thin hook boundary.
 *
 * The harness owns one temp root with a seeded repository, an isolated home
 * directory, the managed runner location, and an artifact directory where
 * runner stubs record pre-push arguments and stdin.
 */
export interface HookHarness {
  /** Directory where runner stubs write assertion artifacts. */
  artifactsDir: string;
  /** Directory prepended to `PATH` for test-local executables. */
  binDir: string;
  /** Base isolated environment used for every harness command. */
  env: NodeJS.ProcessEnv;
  /** Isolated home containing the installer-managed Pushgate runner path. */
  homeDir: string;
  /** Seeded feature repository used as the hook working directory. */
  repoRoot: string;
  /** Parent directory containing every disposable harness resource. */
  tempRoot: string;
  /** Create a local bare origin for tests that need a real `git push`. */
  addBareOrigin(): Promise<string>;
  /** Delete the full temporary harness tree. */
  cleanup(): Promise<void>;
  /** Run Git inside the seeded feature repository. */
  git(args: string[], options?: HookRunOptions): Promise<CommandResult>;
  /** Copy the repository hook into `.git/hooks/pre-push`. */
  installInstalledHook(): Promise<void>;
  /** Copy the repository runner into the managed home runner location. */
  installRealRunner(): Promise<void>;
  /** Install a managed runner stub that records pre-push context. */
  installRunnerStub(options?: RunnerStubOptions): Promise<void>;
  /** Read a runner stub artifact, returning `null` when it does not exist. */
  readArtifact(name: string): Promise<string | null>;
  /** Run the repository hook directly without installing it into `.git`. */
  runHook(options?: HookRunOptions): Promise<CommandResult>;
}

const hookSourcePath = fileURLToPath(
  new URL("../../hook/pre-push", import.meta.url),
);
const runnerSourcePath = fileURLToPath(
  new URL("../../bin/pushgate.mjs", import.meta.url),
);
const systemPath = [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** Managed runner stub used by the thin hook tests. */
const runnerStub = `#!/usr/bin/env bash
set -u

case "\${1:-}" in
  hook-protocol)
    if [ "$#" -ne 1 ]; then
      exit 64
    fi
    if [ "$PUSHGATE_RUNNER_PROTOCOL_EXIT" -ne 0 ]; then
      printf '%s\\n' "$PUSHGATE_RUNNER_PROTOCOL_ERROR" >&2
      exit "$PUSHGATE_RUNNER_PROTOCOL_EXIT"
    fi
    printf '%s\\n' "$PUSHGATE_RUNNER_PROTOCOL"
    ;;
  pre-push)
    printf '%s\\n' "$@" > "$PUSHGATE_STUB_DIR/runner-args.txt"
    cat > "$PUSHGATE_STUB_DIR/runner-stdin.txt"
    exit "$PUSHGATE_RUNNER_EXIT"
    ;;
  *)
    exit 64
    ;;
esac
`;

/**
 * Create a fully isolated harness around a seeded feature repository.
 *
 * The repository starts with `main` at a baseline commit and `feature` at a
 * second commit that preserves the changed-file shapes later runner layers
 * need while giving real pushes normal pre-push input for the hook.
 */
export async function createHookHarness(): Promise<HookHarness> {
  const tempRoot = await mkdtemp(join(tmpdir(), "pushgate-hook-"));
  const repoRoot = join(tempRoot, "repo");
  const homeDir = join(tempRoot, "home");
  const artifactsDir = join(tempRoot, "artifacts");
  const binDir = join(tempRoot, "bin");

  await Promise.all(
    [repoRoot, homeDir, artifactsDir, binDir].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );

  const env = createSandboxEnv(homeDir, artifactsDir, binDir);

  await seedFeatureRepo(repoRoot, env);

  return {
    artifactsDir,
    binDir,
    env,
    homeDir,
    repoRoot,
    tempRoot,
    async addBareOrigin() {
      const remoteRoot = join(tempRoot, "origin.git");

      await checkedRun("git", ["init", "--quiet", "--bare", remoteRoot], {
        cwd: tempRoot,
        env,
      });
      await checkedRun("git", ["remote", "add", "origin", remoteRoot], {
        cwd: repoRoot,
        env,
      });

      return remoteRoot;
    },
    async cleanup() {
      await rm(tempRoot, { force: true, recursive: true });
    },
    async git(args, options = {}) {
      return runCommand("git", args, {
        cwd: repoRoot,
        env: { ...env, ...options.env },
        stdin: options.stdin,
      });
    },
    async installInstalledHook() {
      const installedHook = join(repoRoot, ".git", "hooks", "pre-push");

      await copyFile(hookSourcePath, installedHook);
      await chmod(installedHook, 0o755);
    },
    async installRealRunner() {
      const installedRunner = await prepareRunnerPath(homeDir);

      await copyFile(runnerSourcePath, installedRunner);
      await chmod(installedRunner, 0o755);
    },
    async installRunnerStub(options = {}) {
      const installedRunner = await prepareRunnerPath(homeDir);

      await writeFile(installedRunner, runnerStub);

      if (options.executable !== false) {
        await chmod(installedRunner, 0o755);
      }
    },
    async readArtifact(name) {
      try {
        return await readFile(join(artifactsDir, name), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }

        throw error;
      }
    },
    async runHook(options = {}) {
      return runCommand("bash", [hookSourcePath, ...(options.args ?? [])], {
        cwd: repoRoot,
        env: { ...env, ...options.env },
        stdin: options.stdin,
      });
    },
  };
}

/**
 * Merge hook output streams and strip ANSI colors before matching messages.
 */
export function cleanHookOutput(result: CommandResult): string {
  return `${result.stdout}\n${result.stderr}`.replace(
    /\u001b\[[0-9;]*m/g,
    "",
  );
}

async function prepareRunnerPath(homeDir: string): Promise<string> {
  const runnerDir = join(homeDir, ".pushgate", "bin");

  await mkdir(runnerDir, { recursive: true });
  return join(runnerDir, "pushgate");
}

/** Seed the branch topology reused by direct hook and installed-hook tests. */
async function seedFeatureRepo(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await checkedRun("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: repoRoot,
    env,
  });
  await checkedRun("git", ["config", "user.email", "hook-harness@example.test"], {
    cwd: repoRoot,
    env,
  });
  await checkedRun("git", ["config", "user.name", "Pushgate Hook Harness"], {
    cwd: repoRoot,
    env,
  });

  await Promise.all([
    writeRepoFile(repoRoot, "src/changed.ts", "export const base = true;\n"),
    writeRepoFile(repoRoot, "src/deleted.ts", "export const removeMe = true;\n"),
    writeRepoFile(
      repoRoot,
      "ignored/generated.ts",
      "export const generated = \"base\";\n",
    ),
  ]);
  await commitAll(repoRoot, env, "baseline");

  await checkedRun("git", ["switch", "--quiet", "-c", "feature"], {
    cwd: repoRoot,
    env,
  });
  await Promise.all([
    writeRepoFile(repoRoot, "src/changed.ts", "export const changed = true;\n"),
    writeRepoFile(
      repoRoot,
      "src/file with spaces.ts",
      "export const spaced = true;\n",
    ),
    writeRepoFile(
      repoRoot,
      "ignored/generated.ts",
      "export const generated = \"feature\";\n",
    ),
    rm(join(repoRoot, "src", "deleted.ts")),
  ]);
  await commitAll(repoRoot, env, "feature changes");
}

async function commitAll(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  message: string,
): Promise<void> {
  await checkedRun("git", ["add", "--all"], { cwd: repoRoot, env });
  await checkedRun("git", ["commit", "--quiet", "-m", message], {
    cwd: repoRoot,
    env,
  });
}

async function writeRepoFile(
  repoRoot: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const filePath = join(repoRoot, relativePath);

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

/**
 * Build the environment inherited by commands inside the disposable repo.
 */
function createSandboxEnv(
  homeDir: string,
  artifactsDir: string,
  binDir: string,
): NodeJS.ProcessEnv {
  return {
    ...sanitizeGitLocalEnv(process.env),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: homeDir,
    LC_ALL: "C",
    PATH: [binDir, ...systemPath].join(delimiter),
    PUSHGATE_RUNNER_EXIT: "0",
    PUSHGATE_RUNNER_PROTOCOL: "1",
    PUSHGATE_RUNNER_PROTOCOL_ERROR: "",
    PUSHGATE_RUNNER_PROTOCOL_EXIT: "0",
    PUSHGATE_STUB_DIR: artifactsDir,
    TERM: "dumb",
    XDG_CONFIG_HOME: join(homeDir, ".config"),
  };
}

/** Run setup commands and fail early with captured output on non-zero exits. */
async function checkedRun(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<void> {
  const result = await runCommand(command, args, options);

  if (result.code !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} exited with ${String(result.code)}.`,
        `stdout:\n${result.stdout}`,
        `stderr:\n${result.stderr}`,
      ].join("\n"),
    );
  }
}

interface CommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
}

/** Spawn a command and capture its output without interpreting its exit code. */
function runCommand(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const stdinMode = options.stdin === undefined ? "ignore" : "pipe";

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: command === "git" ? sanitizeGitLocalEnv(options.env) : options.env,
      stdio: [stdinMode, "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";

    if (!child.stdout || !child.stderr) {
      reject(new Error("Harness commands must capture stdout and stderr."));
      return;
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      stdout += data;
    });
    child.stderr.on("data", (data: string) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal, stderr, stdout });
    });

    if (options.stdin !== undefined) {
      if (!child.stdin) {
        reject(new Error("Harness command stdin was not piped."));
        return;
      }

      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") {
          reject(error);
        }
      });
      child.stdin.end(options.stdin);
    }
  });
}

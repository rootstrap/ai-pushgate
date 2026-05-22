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

/**
 * Disposable Git workspace used to characterize hook and runner behavior.
 *
 * The harness owns one temp root with a seeded repository, an isolated home
 * directory, executable stubs on `PATH`, and an artifact directory where those
 * stubs record arguments and prompts for assertions.
 */
export interface HookHarness {
  /** Directory where tool and provider stubs write assertion artifacts. */
  artifactsDir: string;
  /** Directory prepended to `PATH` for test-local executables. */
  binDir: string;
  /** Base isolated environment used for every harness command. */
  env: NodeJS.ProcessEnv;
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
  /** Install the deterministic Claude CLI stub onto the sandbox `PATH`. */
  installClaudeStub(): Promise<void>;
  /** Copy the repository hook into `.git/hooks/pre-push` for push smoke tests. */
  installInstalledHook(): Promise<void>;
  /** Install a deterministic command stub under the given executable name. */
  installToolStub(name?: string): Promise<void>;
  /** Read a stub artifact, returning `null` when the stub did not create it. */
  readArtifact(name: string): Promise<string | null>;
  /** Run the repository hook directly without installing it into `.git`. */
  runHook(options?: HookRunOptions): Promise<CommandResult>;
  /** Write the legacy config consumed by the current Bash hook. */
  writeLegacyConfig(config: string): Promise<void>;
}

const hookSourcePath = fileURLToPath(
  new URL("../../hook/pre-push", import.meta.url),
);

const sandboxSystemPath = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/**
 * Tool stub that records argv as one line per argument.
 *
 * Line-oriented artifacts preserve filenames with whitespace while keeping the
 * test fixtures easy to inspect when a hook expectation fails.
 */
const toolStub = `#!/usr/bin/env bash
set -u

printf '%s\n' "$@" > "$PUSHGATE_STUB_DIR/tool-args.txt"
printf 'tool invoked\n' >> "$PUSHGATE_STUB_DIR/tool-invocations.log"

if [ -n "$PUSHGATE_TOOL_EXIT" ]; then
  printf 'stub tool failed\n' >&2
  exit "$PUSHGATE_TOOL_EXIT"
fi

printf 'stub tool passed\n'
`;

/**
 * Current-hook provider stub.
 *
 * The Bash hook still invokes `claude --print`, so this stub models only the
 * response forms that the characterization tests need before provider adapters
 * and structured output are moved behind the future runner boundary.
 */
const claudeStub = `#!/usr/bin/env bash
set -u

printf '%s\n' "$@" > "$PUSHGATE_STUB_DIR/claude-args.txt"
cat > "$PUSHGATE_STUB_DIR/claude-prompt.txt"

case "$PUSHGATE_CLAUDE_RESULT" in
  pass)
    printf '%s\n' \\
      'SUMMARY' \\
      'blocking_count: 0' \\
      'warning_count: 0' \\
      'verdict: PASS'
    ;;
  warning)
    cat <<'EOF'
FINDING
category: test_coverage
severity: warning
file: src/changed.ts
line: 1
message: stub warning
suggestion: keep the harness exercised

SUMMARY
blocking_count: 0
warning_count: 1
verdict: PASS
EOF
    ;;
  block)
    cat <<'EOF'
FINDING
category: security
severity: blocking
file: src/changed.ts
line: 1
message: stub block
suggestion: fix the blocking finding

SUMMARY
blocking_count: 1
warning_count: 0
verdict: BLOCK
EOF
    ;;
  fail)
    printf 'stub provider failed\n' >&2
    exit 7
    ;;
  empty)
    ;;
  *)
    printf 'unknown claude stub result: %s\n' "$PUSHGATE_CLAUDE_RESULT" >&2
    exit 64
    ;;
esac
`;

/** Non-network stub for the hook update check. */
const curlStub = `#!/usr/bin/env bash
set -u

printf 'curl blocked by hook harness\n' >> "$PUSHGATE_STUB_DIR/curl.log"
exit 22
`;

/**
 * Create a fully isolated harness around a seeded feature repository.
 *
 * The repository starts with `main` at a baseline commit and `feature` at a
 * second commit that changes a regular file, adds a filename with spaces,
 * changes an ignorable path, and deletes a tracked file. Stubs are opt-in per
 * test so missing-tool and missing-provider behavior can be asserted.
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

  await installExecutable(binDir, "curl", curlStub);
  await seedFeatureRepo(repoRoot, env);

  return {
    artifactsDir,
    binDir,
    env,
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
    async installClaudeStub() {
      await installExecutable(binDir, "claude", claudeStub);
    },
    async installInstalledHook() {
      const installedHook = join(repoRoot, ".git", "hooks", "pre-push");

      await copyFile(hookSourcePath, installedHook);
      await chmod(installedHook, 0o755);
    },
    async installToolStub(name = "record-tool") {
      await installExecutable(binDir, name, toolStub);
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
    async writeLegacyConfig(config) {
      await writeFile(join(repoRoot, ".push-review.yml"), config);
    },
  };
}

/**
 * Merge hook output streams and strip ANSI colors before matching messages.
 *
 * Hook tests use this for stable message assertions while artifact assertions
 * cover exact tool/provider invocations.
 */
export function cleanHookOutput(result: CommandResult): string {
  return `${result.stdout}\n${result.stderr}`.replace(
    /\u001b\[[0-9;]*m/g,
    "",
  );
}

/**
 * Seed the branch topology and changed-file shapes reused by hook scenarios.
 */
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

async function installExecutable(
  binDir: string,
  name: string,
  content: string,
): Promise<void> {
  const executablePath = join(binDir, name);

  await writeFile(executablePath, content);
  await chmod(executablePath, 0o755);
}

/**
 * Build the environment inherited by commands inside the disposable repo.
 *
 * User Git configuration and network update checks are isolated so tests do not
 * depend on the developer machine, provider auth, or internet availability.
 */
function createSandboxEnv(
  homeDir: string,
  artifactsDir: string,
  binDir: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: homeDir,
    LC_ALL: "C",
    PATH: [binDir, ...sandboxSystemPath].join(delimiter),
    PUSHGATE_CLAUDE_RESULT: "pass",
    PUSHGATE_STUB_DIR: artifactsDir,
    PUSHGATE_TOOL_EXIT: "",
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
      env: options.env,
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

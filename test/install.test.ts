import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sanitizeGitLocalEnv } from "../src/git/environment.js";

const installerPath = fileURLToPath(new URL("../install.sh", import.meta.url));
const hookSourcePath = fileURLToPath(
  new URL("../hook/pre-push", import.meta.url),
);
const runnerSourcePath = fileURLToPath(
  new URL("../bin/pushgate.mjs", import.meta.url),
);
const templateSourcePath = fileURLToPath(
  new URL("../templates/base.yml", import.meta.url),
);

const curlStub = `#!/usr/bin/env bash
set -eu

destination=""
url=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      destination="$2"
      shift 2
      ;;
    http*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

case "$url" in
  */bin/pushgate.mjs)
    cp "$PUSHGATE_TEST_RUNNER_SOURCE" "$destination"
    ;;
  */hook/pre-push)
    cp "$PUSHGATE_TEST_HOOK_SOURCE" "$destination"
    ;;
  */templates/*.yml)
    cp "$PUSHGATE_TEST_TEMPLATE_SOURCE" "$destination"
    ;;
  *)
    printf 'unexpected curl URL: %s\\n' "$url" >&2
    exit 22
    ;;
esac
`;

test("installs the managed runner, thin hook backup, and v2 config", async () => {
  await withInstallerHarness(async (harness) => {
    const originalHook = "#!/usr/bin/env bash\nprintf 'existing hook\\n'\n";

    await writeFile(join(harness.hooksDir, "pre-push"), originalHook);

    const result = await harness.runInstaller(["--template", "base"]);

    assert.equal(result.code, 0, formatResult(result));

    const runnerPath = join(harness.homeDir, ".pushgate", "bin", "pushgate");
    const runnerStats = await stat(runnerPath);

    assert.ok((runnerStats.mode & 0o111) !== 0);
    assert.match(await readFile(runnerPath, "utf8"), /HOOK_PROTOCOL = "1"/);
    assert.match(
      await readFile(join(harness.hooksDir, "pre-push"), "utf8"),
      /exec node "\$PUSHGATE_RUNNER" pre-push "\$@"/,
    );

    const backups = (await readdir(harness.hooksDir)).filter((name) =>
      name.startsWith("pre-push.backup."),
    );

    assert.equal(backups.length, 1);
    assert.equal(
      await readFile(join(harness.hooksDir, backups[0]), "utf8"),
      originalHook,
    );
    assert.match(
      await readFile(join(harness.repoRoot, ".pushgate.yml"), "utf8"),
      /^version: 2/m,
    );
    await assert.rejects(readFile(join(harness.repoRoot, ".push-review.yml")));
  });
});

test("keeps an existing v2 config during reinstall", async () => {
  await withInstallerHarness(async (harness) => {
    const existingConfig = "version: 2\nai:\n  mode: off\n# keep me\n";

    await writeFile(join(harness.repoRoot, ".pushgate.yml"), existingConfig);

    const result = await harness.runInstaller();

    assert.equal(result.code, 0, formatResult(result));
    assert.equal(
      await readFile(join(harness.repoRoot, ".pushgate.yml"), "utf8"),
      existingConfig,
    );
    await assert.rejects(readFile(join(harness.repoRoot, ".push-review.yml")));
  });
});

interface InstallerHarness {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  hooksDir: string;
  repoRoot: string;
  cleanup(): Promise<void>;
  runInstaller(args?: string[]): Promise<CommandResult>;
}

interface CommandResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

async function withInstallerHarness(
  callback: (harness: InstallerHarness) => Promise<void>,
): Promise<void> {
  const harness = await createInstallerHarness();

  try {
    await callback(harness);
  } finally {
    await harness.cleanup();
  }
}

async function createInstallerHarness(): Promise<InstallerHarness> {
  const tempRoot = await mkdtemp(join(tmpdir(), "pushgate-install-"));
  const repoRoot = join(tempRoot, "repo");
  const homeDir = join(tempRoot, "home");
  const binDir = join(tempRoot, "bin");

  await Promise.all(
    [repoRoot, homeDir, binDir].map((path) => mkdir(path, { recursive: true })),
  );
  await installExecutable(binDir, "curl", curlStub);

  const env = {
    ...sanitizeGitLocalEnv(process.env),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: homeDir,
    LC_ALL: "C",
    PATH: [binDir, dirname(process.execPath), process.env.PATH ?? ""].join(
      delimiter,
    ),
    PUSHGATE_TEST_HOOK_SOURCE: hookSourcePath,
    PUSHGATE_TEST_RUNNER_SOURCE: runnerSourcePath,
    PUSHGATE_TEST_TEMPLATE_SOURCE: templateSourcePath,
    TERM: "dumb",
  };

  await checkedRun("git", ["init", "--quiet"], { cwd: repoRoot, env });

  const hooksDir = join(repoRoot, ".git", "hooks");

  return {
    env,
    homeDir,
    hooksDir,
    repoRoot,
    async cleanup() {
      await rm(tempRoot, { force: true, recursive: true });
    },
    async runInstaller(args = []) {
      return runCommand("bash", [installerPath, ...args], {
        cwd: repoRoot,
        env,
      });
    },
  };
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
}

function runCommand(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: command === "git" ? sanitizeGitLocalEnv(options.env) : options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";

    if (!child.stdout || !child.stderr) {
      reject(new Error("Installer tests must capture stdout and stderr."));
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
    child.on("close", (code) => {
      resolve({ code, stderr, stdout });
    });
  });
}

function formatResult(result: CommandResult): string {
  return [
    `exit: ${String(result.code)}`,
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`,
  ].join("\n");
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  GitChangedFilesError,
  MissingDiffBaseError,
  MissingTargetRefError,
  resolveChangedFiles,
  selectToolChangedFilePaths,
} from "../src/path-policy/index.js";

test("resolves filtered changed paths and preserves Git path metadata", async () => {
  await withFeatureRepo(async (repoRoot) => {
    const resolution = await resolveChangedFiles({
      repoRoot,
      targetBranch: "main",
      ignorePaths: ["*.lock", "dist/**"],
    });
    const filesByPath = new Map(
      resolution.files.map((file) => [file.path, file]),
    );

    assert.equal(resolution.targetRef, "main");
    assert.match(resolution.targetCommit, /^[0-9a-f]{40}$/);
    assert.match(resolution.diffBase, /^[0-9a-f]{40}$/);
    assert.equal(resolution.reviewRange, `${resolution.targetCommit}...HEAD`);
    assert.equal(resolution.scanRange, `${resolution.diffBase}..HEAD`);

    assert.deepEqual(filesByPath.get("src/modified.ts"), {
      additions: 1,
      binary: false,
      deletions: 1,
      path: "src/modified.ts",
      status: "modified",
    });
    assert.deepEqual(filesByPath.get("src/deleted.ts"), {
      additions: 0,
      binary: false,
      deletions: 1,
      path: "src/deleted.ts",
      status: "deleted",
    });
    assert.deepEqual(filesByPath.get("src/rename-after.ts"), {
      additions: 0,
      binary: false,
      deletions: 0,
      path: "src/rename-after.ts",
      previousPath: "src/rename-before.ts",
      status: "renamed",
    });
    assert.deepEqual(filesByPath.get("src/file with spaces.ts"), {
      additions: 1,
      binary: false,
      deletions: 0,
      path: "src/file with spaces.ts",
      status: "added",
    });
    assert.deepEqual(filesByPath.get("assets/logo.bin"), {
      additions: null,
      binary: true,
      deletions: null,
      path: "assets/logo.bin",
      status: "added",
    });
    assert.equal(filesByPath.has("packages/app/dependency.lock"), false);
    assert.equal(filesByPath.has("dist/generated.ts"), false);

    assert.deepEqual(
      selectToolChangedFilePaths(resolution.files, [".ts"]).sort(),
      [
        "src/file with spaces.ts",
        "src/modified.ts",
        "src/rename-after.ts",
      ],
    );
  });
});

test("reports a configured target ref that does not exist locally", async () => {
  await withFeatureRepo(async (repoRoot) => {
    await assert.rejects(
      resolveChangedFiles({ repoRoot, targetBranch: "develop" }),
      (error) => {
        assert.ok(error instanceof MissingTargetRefError);
        assert.equal(error.code, "PUSHGATE_PATH_TARGET_REF_MISSING");
        assert.match(error.message, /develop/);
        return true;
      },
    );
  });
});

test("reports histories with no usable merge base", async () => {
  await withTempDir("pushgate-path-unrelated-", async (repoRoot) => {
    await initRepo(repoRoot);
    await writeRepoFile(repoRoot, "main.txt", "main history\n");
    await commitAll(repoRoot, "main");

    await checkedGit(repoRoot, ["switch", "--quiet", "--orphan", "feature"]);
    await writeRepoFile(repoRoot, "feature.txt", "feature history\n");
    await commitAll(repoRoot, "feature");

    await assert.rejects(
      resolveChangedFiles({ repoRoot, targetBranch: "main" }),
      (error) => {
        assert.ok(error instanceof MissingDiffBaseError);
        assert.equal(error.code, "PUSHGATE_PATH_DIFF_BASE_MISSING");
        assert.match(error.message, /does not guess a fallback/);
        return true;
      },
    );
  });
});

test("reports Git inspection failures before path parsing", async () => {
  await withTempDir("pushgate-path-no-repo-", async (repoRoot) => {
    await assert.rejects(
      resolveChangedFiles({ repoRoot, targetBranch: "main" }),
      (error) => {
        assert.ok(error instanceof GitChangedFilesError);
        assert.equal(error.code, "PUSHGATE_PATH_GIT_FAILED");
        assert.match(error.message, /not a git repository/i);
        return true;
      },
    );
  });
});

async function withFeatureRepo(
  callback: (repoRoot: string) => Promise<void>,
): Promise<void> {
  await withTempDir("pushgate-path-feature-", async (repoRoot) => {
    await initRepo(repoRoot);
    await Promise.all([
      writeRepoFile(repoRoot, "src/modified.ts", "export const base = true;\n"),
      writeRepoFile(repoRoot, "src/deleted.ts", "export const remove = true;\n"),
      writeRepoFile(
        repoRoot,
        "src/rename-before.ts",
        "export const renamed = true;\n",
      ),
    ]);
    await commitAll(repoRoot, "baseline");

    await checkedGit(repoRoot, ["switch", "--quiet", "-c", "feature"]);
    await checkedGit(repoRoot, ["mv", "src/rename-before.ts", "src/rename-after.ts"]);
    await Promise.all([
      writeRepoFile(
        repoRoot,
        "src/modified.ts",
        "export const modified = true;\n",
      ),
      writeRepoFile(
        repoRoot,
        "src/file with spaces.ts",
        "export const spaced = true;\n",
      ),
      writeRepoFile(repoRoot, "src/note.md", "# changed\n"),
      writeRepoFile(repoRoot, "dist/generated.ts", "generated\n"),
      writeRepoFile(repoRoot, "packages/app/dependency.lock", "lock\n"),
      writeRepoFile(repoRoot, "assets/logo.bin", Buffer.from([0, 1, 2, 3])),
      rm(join(repoRoot, "src", "deleted.ts")),
    ]);
    await commitAll(repoRoot, "feature changes");

    await callback(repoRoot);
  });
}

async function withTempDir(
  prefix: string,
  callback: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const repoRoot = await mkdtemp(join(tmpdir(), prefix));

  try {
    await callback(repoRoot);
  } finally {
    await rm(repoRoot, { force: true, recursive: true });
  }
}

async function initRepo(repoRoot: string): Promise<void> {
  await checkedGit(repoRoot, ["init", "--quiet", "--initial-branch=main"]);
  await checkedGit(repoRoot, [
    "config",
    "user.email",
    "path-policy@example.test",
  ]);
  await checkedGit(repoRoot, ["config", "user.name", "Pushgate Path Policy"]);
}

async function commitAll(repoRoot: string, message: string): Promise<void> {
  await checkedGit(repoRoot, ["add", "--all"]);
  await checkedGit(repoRoot, ["commit", "--quiet", "-m", message]);
}

async function writeRepoFile(
  repoRoot: string,
  relativePath: string,
  content: string | Buffer,
): Promise<void> {
  const filePath = join(repoRoot, relativePath);

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

interface GitResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

async function checkedGit(repoRoot: string, args: string[]): Promise<void> {
  const result = await runGit(repoRoot, args);

  if (result.code !== 0) {
    throw new Error(
      [
        `git ${args.join(" ")} exited with ${String(result.code)}.`,
        `stdout:\n${result.stdout}`,
        `stderr:\n${result.stderr}`,
      ].join("\n"),
    );
  }
}

function runGit(repoRoot: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";

    if (!child.stdout || !child.stderr) {
      reject(new Error("Path-policy tests must capture Git output."));
      return;
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      stdout += data;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stderr, stdout });
    });
  });
}

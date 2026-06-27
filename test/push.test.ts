import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";

import {
  branchFromRefspec,
  parseGitPushArgs,
  resolveGitPushSuccessSummary,
  writeGitPushSuccessSummary,
} from "../src/git/push.js";

const execFileAsync = promisify(execFile);

test("writeGitPushSuccessSummary uses shared terminal result formatting", () => {
  const output = captureOutput();

  Object.defineProperty(output.stream, "isTTY", {
    configurable: true,
    value: true,
  });

  writeGitPushSuccessSummary(
    output.stream,
    {
      kind: "branch-update",
      pullRequestUrl: "https://github.com/rootstrap/ai-pushgate/pull/new/main",
      upstream: "origin/main",
    },
    {
      env: {
        CI: "1",
        FORCE_COLOR: "1",
        TERM: "xterm-256color",
      },
    },
  );

  assert.match(output.text(), /\u001B\[1mPushing branch\u001B\[22m/);
  assert.match(output.text(), /  \u001B\[32m✓\u001B\[39m Branch pushed/);
  assert.match(
    output.text(),
    /  \u001B\[32m✓\u001B\[39m Upstream set\s+origin\/main/,
  );
  assert.match(
    output.text(),
    /\u001B\[1mCreate a pull request:\u001B\[22m/,
  );
});

test("writeGitPushSuccessSummary stays quiet for non-branch pushes", () => {
  const output = captureOutput();

  writeGitPushSuccessSummary(output.stream, { kind: "non-branch" });

  assert.equal(output.text(), "");
});

test("branchFromRefspec returns the pushed destination branch", () => {
  assert.equal(branchFromRefspec("feature"), "feature");
  assert.equal(branchFromRefspec("+feature"), "feature");
  assert.equal(branchFromRefspec("refs/heads/feature"), "feature");
  assert.equal(branchFromRefspec("feature:release"), "release");
  assert.equal(branchFromRefspec("HEAD:refs/heads/target"), "target");
  assert.equal(
    branchFromRefspec("+refs/heads/src:refs/heads/dst"),
    "dst",
  );
});

test("branchFromRefspec ignores refspecs that cannot name a pushed branch", () => {
  assert.equal(branchFromRefspec(""), undefined);
  assert.equal(branchFromRefspec("   "), undefined);
  assert.equal(branchFromRefspec("HEAD"), undefined);
  assert.equal(branchFromRefspec("refs/heads/*:refs/heads/*"), undefined);
  assert.equal(branchFromRefspec(":refs/heads/old"), undefined);
  assert.equal(branchFromRefspec("+:refs/heads/old"), undefined);
  assert.equal(branchFromRefspec("refs/heads/source:"), undefined);
  assert.equal(branchFromRefspec("refs/tags/v1.0.0"), undefined);
});

test("parseGitPushArgs handles repository option forms", () => {
  assert.deepEqual(parseGitPushArgs(["--repo", "origin", "feature"]), {
    branch: "feature",
    intent: "branch-update",
    remote: "origin",
    setsUpstream: false,
  });
  assert.deepEqual(parseGitPushArgs(["--repo=origin", "feature"]), {
    branch: "feature",
    intent: "branch-update",
    remote: "origin",
    setsUpstream: false,
  });
  assert.deepEqual(
    parseGitPushArgs(["--set-upstream", "--repo=origin", "HEAD:release"]),
    {
      branch: "release",
      intent: "branch-update",
      remote: "origin",
      setsUpstream: true,
    },
  );
});

test("parseGitPushArgs respects option values and the option terminator", () => {
  assert.deepEqual(
    parseGitPushArgs([
      "--receive-pack",
      "git-receive-pack",
      "--push-option",
      "ci.skip",
      "origin",
      "feature",
    ]),
    {
      branch: "feature",
      intent: "branch-update",
      remote: "origin",
      setsUpstream: false,
    },
  );
  assert.deepEqual(parseGitPushArgs(["--", "origin", "feature"]), {
    branch: "feature",
    intent: "branch-update",
    remote: "origin",
    setsUpstream: false,
  });
  assert.deepEqual(parseGitPushArgs(["--repo=origin", "--", "feature"]), {
    branch: "feature",
    intent: "branch-update",
    remote: "origin",
    setsUpstream: false,
  });
});

test("parseGitPushArgs marks non-branch push intents", () => {
  assert.deepEqual(parseGitPushArgs(["--delete", "origin", "feature"]), {
    branch: "feature",
    intent: "non-branch",
    remote: "origin",
    setsUpstream: false,
  });
  assert.deepEqual(parseGitPushArgs(["origin", ":feature"]), {
    branch: undefined,
    intent: "non-branch",
    remote: "origin",
    setsUpstream: false,
  });
  assert.deepEqual(parseGitPushArgs(["origin", "refs/tags/v1.0.0"]), {
    branch: undefined,
    intent: "non-branch",
    remote: "origin",
    setsUpstream: false,
  });
  assert.deepEqual(parseGitPushArgs(["--tags", "origin"]), {
    branch: undefined,
    intent: "non-branch",
    remote: "origin",
    setsUpstream: false,
  });
  assert.deepEqual(parseGitPushArgs(["--mirror", "origin"]), {
    branch: undefined,
    intent: "non-branch",
    remote: "origin",
    setsUpstream: false,
  });
});

test("resolveGitPushSuccessSummary parses repository options from push args", async () => {
  await withGitRemote(
    "git@github.com:rootstrap/ai-pushgate.git",
    async (env) => {
      assert.deepEqual(
        await resolveGitPushSuccessSummary(
          ["--receive-pack=git-receive-pack", "--repo=origin", "feature"],
          { env },
        ),
        {
          kind: "branch-update",
          pullRequestUrl:
            "https://github.com/rootstrap/ai-pushgate/pull/new/feature",
          upstream: undefined,
        },
      );

      assert.deepEqual(
        await resolveGitPushSuccessSummary(
          ["--repo", "origin", "refs/heads/feature:refs/heads/release"],
          { env },
        ),
        {
          kind: "branch-update",
          pullRequestUrl:
            "https://github.com/rootstrap/ai-pushgate/pull/new/release",
          upstream: undefined,
        },
      );

      assert.deepEqual(
        await resolveGitPushSuccessSummary(
          ["--set-upstream", "--repo=origin", "feature"],
          { env },
        ),
        {
          kind: "branch-update",
          pullRequestUrl:
            "https://github.com/rootstrap/ai-pushgate/pull/new/feature",
          upstream: "origin/feature",
        },
      );
    },
  );
});

test("resolveGitPushSuccessSummary skips branch copy for non-branch pushes", async () => {
  await withGitRemote(
    "git@github.com:rootstrap/ai-pushgate.git",
    async (env) => {
      assert.deepEqual(
        await resolveGitPushSuccessSummary(["--delete", "origin", "feature"], {
          env,
        }),
        { kind: "non-branch" },
      );
      assert.deepEqual(
        await resolveGitPushSuccessSummary(["origin", ":feature"], { env }),
        { kind: "non-branch" },
      );
      assert.deepEqual(
        await resolveGitPushSuccessSummary(["origin", "refs/tags/v1.0.0"], {
          env,
        }),
        { kind: "non-branch" },
      );
      assert.deepEqual(
        await resolveGitPushSuccessSummary(["--tags", "origin"], { env }),
        { kind: "non-branch" },
      );
      assert.deepEqual(
        await resolveGitPushSuccessSummary(["--mirror", "origin"], { env }),
        { kind: "non-branch" },
      );
    },
  );
});

test("resolveGitPushSuccessSummary ignores remotes that cannot become GitHub pull request URLs", async () => {
  await withGitRemote(
    "https://gitlab.com/rootstrap/ai-pushgate.git",
    async (env) => {
      assert.deepEqual(
        await resolveGitPushSuccessSummary(["origin", "feature"], { env }),
        {
          kind: "branch-update",
          pullRequestUrl: undefined,
          upstream: undefined,
        },
      );
    },
  );

  await withGitRemote("not a url", async (env) => {
    assert.deepEqual(
      await resolveGitPushSuccessSummary(["origin", "feature"], { env }),
      {
        kind: "branch-update",
        pullRequestUrl: undefined,
        upstream: undefined,
      },
    );
  });
});

test("resolveGitPushSuccessSummary treats git command failures as best effort misses", async () => {
  const env = {
    ...process.env,
    PATH: join(
      tmpdir(),
      `.missing-pushgate-git-path-${String(process.pid)}`,
    ),
  };

  assert.deepEqual(
    await resolveGitPushSuccessSummary(["origin", "feature"], { env }),
    {
      kind: "branch-update",
      pullRequestUrl: undefined,
      upstream: undefined,
    },
  );
});

function captureOutput(): {
  stream: Writable;
  text(): string;
} {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });

  return {
    stream,
    text() {
      return output;
    },
  };
}

async function withGitRemote(
  remoteUrl: string,
  callback: (env: NodeJS.ProcessEnv) => Promise<void>,
): Promise<void> {
  const repoRoot = await mkdtemp(join(tmpdir(), "pushgate-push-"));

  try {
    await execFileAsync("git", ["init", "--quiet"], { cwd: repoRoot });
    await execFileAsync("git", ["config", "remote.origin.url", remoteUrl], {
      cwd: repoRoot,
    });

    await callback({
      ...process.env,
      GIT_DIR: join(repoRoot, ".git"),
      GIT_WORK_TREE: repoRoot,
    });
  } finally {
    await rm(repoRoot, { force: true, recursive: true });
  }
}

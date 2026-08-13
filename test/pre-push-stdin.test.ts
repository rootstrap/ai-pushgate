import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  parsePrePushLine,
  parseBranchFromPrePushLine,
  readPrePushInputFromStdin,
  readPrePushBranchFromStdin,
} from "../src/workflows/pre-push.js";

test("parseBranchFromPrePushLine returns the local branch ref", () => {
  assert.equal(
    parseBranchFromPrePushLine(
      "refs/heads/feature local-sha refs/heads/feature remote-sha",
    ),
    "feature",
  );
  assert.equal(
    parseBranchFromPrePushLine(
      "refs/tags/v1.0.0 local-sha refs/tags/v1.0.0 remote-sha",
    ),
    undefined,
  );
  assert.equal(parseBranchFromPrePushLine(""), undefined);
});

test("parsePrePushLine returns branch update metadata from Git pre-push input", () => {
  assert.deepEqual(
    parsePrePushLine(
      "refs/heads/feature local-sha refs/heads/feature remote-sha",
    ),
    {
      localBranch: "feature",
      localRef: "refs/heads/feature",
      localSha: "local-sha",
      remoteBranch: "feature",
      remoteRef: "refs/heads/feature",
      remoteSha: "remote-sha",
    },
  );
  assert.equal(
    parsePrePushLine(
      "refs/tags/v1.0.0 local-sha refs/tags/v1.0.0 remote-sha",
    ),
    null,
  );
  assert.equal(parsePrePushLine(""), null);
});

test("readPrePushInputFromStdin keeps every bounded branch update", async () => {
  const input = await readPrePushInputFromStdin(
    Readable.from([
      "refs/tags/v1.0.0 local-sha refs/tags/v1.0.0 remote-sha\n",
      "refs/heads/feature local-sha refs/heads/feature remote-sha\n",
      "refs/heads/other other-local-sha refs/heads/other other-remote-sha\n",
    ]),
  );

  assert.deepEqual(input.branchUpdates, [
    {
      localBranch: "feature",
      localRef: "refs/heads/feature",
      localSha: "local-sha",
      remoteBranch: "feature",
      remoteRef: "refs/heads/feature",
      remoteSha: "remote-sha",
    },
    {
      localBranch: "other",
      localRef: "refs/heads/other",
      localSha: "other-local-sha",
      remoteBranch: "other",
      remoteRef: "refs/heads/other",
      remoteSha: "other-remote-sha",
    },
  ]);
});

test("readPrePushBranchFromStdin parses incrementally and discards trailing input", async () => {
  const branch = await readPrePushBranchFromStdin(
    Readable.from([
      "refs/tags/v1.0.0 local-sha refs/tags/v1.0.0 remote-sha\n",
      "refs/heads/feature local-sha refs/heads/feature remote-sha\n",
      "x".repeat(2 * 1024 * 1024),
    ]),
  );

  assert.equal(branch, "feature");
});

test("readPrePushBranchFromStdin skips oversized lines without buffering them", async () => {
  const branch = await readPrePushBranchFromStdin(
    Readable.from([
      "x".repeat(128 * 1024),
      "\n",
      "refs/heads/main local-sha refs/heads/main remote-sha\n",
    ]),
  );

  assert.equal(branch, "main");
});

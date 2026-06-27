import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import {
  branchFromRefspec,
  writeGitPushSuccessSummary,
} from "../src/git/push.js";

test("writeGitPushSuccessSummary uses shared terminal result formatting", () => {
  const output = captureOutput();

  Object.defineProperty(output.stream, "isTTY", {
    configurable: true,
    value: true,
  });

  writeGitPushSuccessSummary(
    output.stream,
    {
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

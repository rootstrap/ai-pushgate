# Issue 18 Local Skip Controls Plan

This document narrows issue #18 into the knowledge gaps, open questions, and
execution plan for the documented one-push skip controls.

The broader product contract remains in `docs/product-contract-plan.md`. The
v2 config boundary remains in `docs/issue-2-config-schema-plan.md` and
`docs/v2-config-schema.md`. The thin hook and managed runner boundary already
landed in issue #4, while local AI provider execution still belongs to later
M3 issues.

## Known Context

Issue #18 owns the documented skip-control contract:

1. `git -c pushgate.skip-all-checks=true push`
2. `git -c pushgate.skip-ai-check=true push`
3. `pushgate push --skip-all-checks`
4. `pushgate push --skip-ai-check`

The current repository state matters for this work:

| Area | Current state | Planning implication |
|---|---|---|
| Installed hook | `hook/pre-push` is already a thin delegator to the managed runner. | Skip behavior belongs in the runner and wrapper, not the installed hook. |
| Runner CLI | `src/cli.ts` supports `hook-protocol` and `pre-push` only. | Issue #18 must add a `push` command surface without breaking current hook usage. |
| Deterministic runner | `runPrePush` loads `.pushgate.yml`, resolves changed files, and runs built-in policies plus tools. | Whole-runner skip needs an early exit before deterministic work begins. |
| Local AI execution | The config contract supports `blocking`, `advisory`, and `off`, but no provider execution path exists yet. | AI-only skip must be future-ready without accidentally expanding issue #18 into issues #10, #11, or #12. |
| Public docs | `README.md` and `docs/product-contract-plan.md` already document the Git-config and wrapper skip vocabulary. | The implementation should match the existing contract instead of redefining it. |
| Test harness | `test/hook.test.ts`, `test/runner.test.ts`, and `test/support/hook-harness.ts` already support direct runner tests and real installed-hook push smoke tests. | Issue #18 can verify one-command `git -c` behavior with real pushes instead of only unit-level mocks. |

## Scope Boundaries

Issue #18 should implement the documented skip-control behavior and its tests.
It should not silently take ownership of these later backlog surfaces:

| Surface | Backlog owner |
|---|---|
| Final changed-file policy behavior | Issue #5 |
| AI provider interface and Claude adapter | Issue #10 |
| Local AI mode and guardrail behavior | Issue #11 |
| Structured AI findings and rendering | Issue #12 |
| GitHub Copilot provider adapter | Issue #19 |

The skip-control work may add small seams that those later issues consume, but
it should not implement provider execution or structured AI output now.

## Locked Definitions To Preserve

- `git push` remains the primary developer entry point.
- `git push --no-verify` remains Git's broad bypass because the hook does not
  run.
- The documented Pushgate-specific escape hatches use Git's temporary config
  channel and the matching `pushgate push --skip-*` wrapper flags.
- `skip-ai-check` must keep deterministic checks running.
- `skip-all-checks` must bypass deterministic checks and local AI when the
  hook still runs.
- `.pushgate.yml` remains the v2 config surface. The skip work should not
  reintroduce `.push-review.yml` behavior.

## Knowledge Gaps And Open Questions

### Skip Precedence And Sources

- If both skip flags are present, should `skip-all-checks` always win over
  `skip-ai-check`, and should the output make that precedence explicit?
- Should issue #18 support only Git-config keys as the public contract, or
  should it also preserve any environment-variable aliases for automation?
- Should persistent `git config pushgate.skip-*` values be treated as valid
  inputs, ignored, or surfaced with a warning because the public contract
  prefers one-command overrides?
- How should invalid Git-config values behave: treat only truthy values as
  active, accept Git boolean parsing semantics, or fail explicitly?

### Evaluation Order

- Should `skip-all-checks` bypass config loading entirely, or should the runner
  still require a valid `.pushgate.yml` before honoring the skip?
- Should `skip-all-checks` bypass changed-file resolution too, so missing
  target-branch errors do not block an intentional full skip?
- Should `skip-ai-check` be evaluated before config loading, after config
  loading, or only immediately before the future AI invocation seam?
- When `ai.mode: off`, should `skip-ai-check` print a no-op message, the normal
  AI-skip message, or nothing at all?

### Wrapper Contract

- Should `pushgate push` preserve every Git argument and exit code exactly,
  merely prefixing `git -c ... push`, or should it do any validation beyond the
  documented skip flags?
- Should `pushgate push --skip-all-checks --skip-ai-check` be accepted and
  normalized to the broader skip, or rejected as ambiguous?
- Should wrapper usage text and argument parsing leave room for future friendly
  flags without creating a second Git-like CLI surface?
- Which Git executable lookup and error message should the wrapper use when
  `git` is missing from `PATH`?

### Current Scope Versus Future AI

- Because no AI provider execution exists yet, what observable behavior should
  `skip-ai-check` prove in issue #18 beyond "deterministic checks still run"?
- Should issue #18 introduce a small runner-level AI phase boundary now so
  later AI issues plug into a defined seam instead of editing `runPrePush`
  again?
- What terminal output should represent "AI skipped" today so later provider
  work can reuse it without a breaking wording change?

### Verification Strategy

- Which scenarios should use real `git push` to prove the one-command Git config
  path, and which scenarios are cheaper as direct runner tests?
- Should skip precedence be covered only through runner unit tests, or also
  through an installed-hook smoke test so Git config scoping is proven end to
  end?
- How much transcript text should tests lock down versus matching just the
  contract-level output markers for skipped deterministic work and skipped AI?

## Working Decisions For Execution

These decisions keep issue #18 implementable without pulling M3 AI work into
scope:

1. Treat Git config as the only required skip-control input for this issue.
   Environment aliases remain out of contract unless the repo already depends
   on them, which it does not today.
2. Let `skip-all-checks` take precedence over `skip-ai-check`.
3. Evaluate `skip-all-checks` after repository discovery but before config
   loading, changed-file resolution, deterministic checks, or future AI work.
4. Evaluate `skip-ai-check` after config loading and deterministic checks but
   before the future AI execution seam.
5. Add a small runner-level seam for the post-deterministic AI phase even if
   that seam is currently a no-op. That keeps the skip logic from becoming
   dead code once issues #10 and #11 land.
6. Implement `pushgate push` as a thin wrapper over `git`, injecting the
   matching temporary config keys and otherwise forwarding arguments unchanged.
7. Keep output concise and explicit so users can tell whether the whole runner
   was skipped or only the AI phase was skipped.

## Execution Plan

1. Add a skip-resolution boundary in the runner CLI.
   - Introduce a small utility that reads Git config booleans for
     `pushgate.skip-all-checks` and `pushgate.skip-ai-check`.
   - Reuse normal Git boolean semantics instead of inventing custom parsing.
   - Return one normalized internal skip state with explicit precedence.

2. Wire whole-runner skip into `pre-push`.
   - Resolve repo root first so the runner can query repository-scoped Git
     config reliably.
   - Short-circuit `runPrePush` when `skip-all-checks` is active.
   - Print one clear message that deterministic checks and local AI were
     intentionally skipped.
   - Avoid loading `.pushgate.yml` or resolving changed files on this path.

3. Introduce a post-deterministic AI seam and AI-only skip handling.
   - Split `runPrePush` into deterministic work followed by a dedicated AI
     phase function.
   - Keep the AI phase as a no-op for now except for skip-aware messaging and
     future extension points.
   - When `skip-ai-check` is active, print a clear AI-skip message while
     preserving deterministic exit behavior.

4. Add the `pushgate push` wrapper command.
   - Extend `src/cli.ts` usage text and command dispatch.
   - Parse `--skip-all-checks` and `--skip-ai-check`.
   - Spawn `git` with `-c pushgate.skip-*=true push ...rest`.
   - Preserve Git's exit code and stdout/stderr behavior.
   - Keep unsupported wrapper flags and missing-`git` failures actionable.

5. Add focused tests at the right layers.
   - Add direct runner tests for skip precedence and early-exit behavior.
   - Add CLI tests for `pushgate push` flag parsing and Git command shaping.
   - Add installed-hook or real-push harness tests that prove
     `git -c pushgate.skip-all-checks=true push` bypasses deterministic work.
   - Add installed-hook or real-push harness tests that prove
     `git -c pushgate.skip-ai-check=true push` still runs deterministic checks.
   - Keep transcript assertions focused on contract-level skip markers.

6. Align docs and examples with the implemented behavior.
   - Verify `README.md` skip examples still match actual CLI behavior.
   - Add any missing wording around precedence or current AI-no-op semantics if
     the implementation makes that newly explicit.
   - Keep the documentation scoped to what issue #18 truly implements, without
     claiming the future provider work already exists.

## Verification Target

Issue #18 is ready to close when:

1. `git -c pushgate.skip-all-checks=true push` bypasses runner work when the
   hook runs.
2. `git -c pushgate.skip-ai-check=true push` preserves deterministic checks and
   activates the AI-only skip path.
3. `pushgate push --skip-all-checks` and `pushgate push --skip-ai-check` map
   to the same underlying Git-config behavior.
4. Skip precedence and output are explicit in tests.
5. The implementation leaves a clear seam for later AI provider work instead
   of hard-coding skip behavior into one monolithic `runPrePush` function.

## Current Repo Touchpoints

| Area | Current file | Expected change |
|---|---|---|
| Runner CLI | `src/cli.ts` | Add `push` subcommand and wrapper argument handling |
| Runner entry path | `src/cli.ts` | Resolve skip state inside `runPrePush` and split deterministic versus AI phases |
| Git-config helper | new module under `src/` | Normalize `pushgate.skip-*` state and precedence |
| Installed hook | `hook/pre-push` | No behavior change expected; it should keep delegating |
| Bundled runner | `bin/pushgate.mjs` | Rebuilt after CLI and runner changes |
| Runner tests | `test/runner.test.ts` | Add skip precedence and early-exit coverage |
| Hook integration tests | `test/hook.test.ts` and `test/support/hook-harness.ts` | Add real-push assertions for Git-config skip behavior |
| Docs | `README.md` and this plan | Align wording with the final implemented behavior |

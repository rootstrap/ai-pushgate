# Refactor 01 Process And Git Helpers Plan

This document turns the first simplification slice into a concrete, behavior-preserving PR plan.

The goal is to reduce repeated `spawn` and Git output handling without changing the Pushgate runtime contract. This slice should make later CLI, path-policy, and AI refactors smaller and safer.

## Verified Context

The generated Understand Anything graph identifies `src/cli.ts`, `src/path-policy/index.ts`, and `src/config/index.ts` as the highest-connectivity areas. Source inspection also shows repeated process and Git command handling in:

| Area | Current file | Current responsibility |
|---|---|---|
| CLI repository lookup | `src/cli.ts` | Runs `git rev-parse --show-toplevel` and formats failure output |
| Push wrapper | `src/cli.ts` | Spawns `git push` with one-command skip config |
| Skip controls | `src/skip-controls.ts` | Reads `git config --bool --get pushgate.skip-*` |
| Changed-file policy | `src/path-policy/index.ts` | Runs `git rev-parse`, `git merge-base`, `git diff --name-status`, and `git diff --numstat` |
| AI prompt assembly | `src/ai/review-prompt.ts` | Runs `git diff` for provider-neutral review context |
| Deterministic runner | `src/runner/deterministic.ts` | Runs configured tool commands with output capture and timeouts |
| AI providers | `src/ai/providers/*.ts` | Run provider CLIs with stdin prompts, output capture, timeouts, and provider-specific auth handling |

`pnpm test` is currently green with 74 passing tests. That is the baseline for this refactor.

## Scope Boundaries

This PR should extract shared process and Git utilities only where the behavior is already generic.

In scope:

- Add a shared captured command runner for simple stdout, stderr, exit-code capture.
- Add Git helpers for repository root lookup, checked Git output, and boolean Git config reads.
- Replace duplicated Git process code in `cli`, `skip-controls`, `path-policy`, and AI prompt diff collection.
- Preserve existing error classes and user-facing messages.
- Keep package exports stable.

Out of scope:

- Do not split `src/path-policy/index.ts` yet.
- Do not split `src/config/index.ts` yet.
- Do not extract provider command runners yet. Provider adapters have stdin, auth, timeout, and output parsing behavior that deserves a separate PR.
- Do not redesign deterministic command execution. It has tool-specific timeout and output-tail semantics.

## Proposed Files

Add:

| New file | Responsibility |
|---|---|
| `src/process/run-command.ts` | Generic captured command execution with optional cwd, env, stdin mode, and output encoding |
| `src/git/command.ts` | Thin Git command wrappers over `runCommand` |
| `src/git/repository.ts` | `resolveRepoRoot` and repository-related Git helpers |
| `src/git/config.ts` | Git boolean config read helpers and config-specific errors or result types |
| `src/git/push.ts` | Optional home for wrapper `git push` execution if it keeps `cli.ts` cleaner without growing the first PR |

Potential exports:

```ts
export interface CommandResult {
  code: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function runCommand(options: RunCommandOptions): Promise<CommandResult>;
export function runGit(repoRoot: string, args: readonly string[], options?: GitCommandOptions): Promise<CommandResult>;
export function runGitChecked(repoRoot: string, args: readonly string[], options?: GitCommandOptions): Promise<string>;
export function resolveGitRepositoryRoot(env?: NodeJS.ProcessEnv): Promise<string>;
export function readGitBooleanConfig(repoRoot: string, key: string, env?: NodeJS.ProcessEnv): Promise<boolean>;
```

The exact signatures can be adjusted during implementation, but callers should not need to know about `child_process.spawn`.

## Execution Plan

1. Add `src/process/run-command.ts`.
   - Capture stdout and stderr as strings by default.
   - Support `cwd`, `env`, and ignored stdin.
   - Return exit code and signal without throwing on non-zero status.
   - Throw only for spawn errors unless a caller wants a result-shaped spawn failure.

2. Add Git helpers.
   - Wrap `git` invocation in one place.
   - Add checked-output helper for commands where non-zero means a domain error.
   - Add repository-root helper for `git rev-parse --show-toplevel`.
   - Add boolean-config helper for `git config --bool --get`.

3. Update `src/cli.ts`.
   - Replace local `resolveRepoRoot` process code.
   - Optionally replace `runPushCommand` spawn details with `src/git/push.ts`.
   - Keep `main`, usage rendering, command dispatch, and final error rendering in place.

4. Update `src/skip-controls.ts`.
   - Keep `buildGitPushArgs`, `SkipControlError`, and `resolveSkipControlState` public behavior.
   - Move command execution to `src/git/config.ts`.
   - Preserve handling for absent config values, invalid boolean output, and Git failures.

5. Update `src/path-policy/index.ts`.
   - Replace the local `runGit` and `runGitChecked` helpers.
   - Keep `GitChangedFilesError`, parsing, filtering, and exported APIs unchanged.
   - Preserve Buffer-sensitive parsing if `--name-status -z` and `--numstat -z` still need raw output. If the generic runner is string-only at first, leave path-policy raw output for a later parser split.

6. Update `src/ai/review-prompt.ts`.
   - Use the Git helper for review diff collection.
   - Preserve the current error message when diff collection fails.

7. Run validation.
   - `pnpm test`
   - Optionally regenerate the Understand Anything graph and compare connectivity for `cli`, `skip-controls`, and `path-policy`.

## Acceptance Criteria

- `pnpm test` passes.
- `src/cli.ts`, `src/skip-controls.ts`, and `src/ai/review-prompt.ts` no longer import `node:child_process`.
- `src/path-policy/index.ts` no longer owns generic Git process execution unless raw Buffer output makes this too risky for PR 1.
- User-facing Pushgate output remains unchanged for existing tests.
- No package export paths change.

## Graph Scorecard

After this PR, the graph should show new low-level utility nodes in a supporting runtime layer while `cli.ts` and `skip-controls.ts` lose direct process-execution edges. The 6 top-level layers should remain intact.

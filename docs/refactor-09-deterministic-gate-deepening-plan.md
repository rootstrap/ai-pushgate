# Refactor 09 Deterministic Gate Deepening Plan

This document turns the deterministic gate simplification into a concrete PR plan.

The goal is to keep `runDeterministicChecks` as the caller-facing interface while moving tool execution, policy evaluation, transcript rendering, and exit decision logic behind clearer internal modules.

## Verified Context

`src/runner/deterministic.ts` is one of the remaining dense source modules. It has good leverage for callers, but its implementation has several reasons to change in one file.

| Concern | Current state |
|---|---|
| Public interface | `runDeterministicChecks(config, changedFiles, options)` returns an exit code and results. |
| Built-in policies | `src/runner/policies.ts` evaluates `diff_size` and `forbidden_paths`. |
| Tool selection | `deterministic.ts` chooses changed files per tool extension and run mode. |
| Tool execution | `deterministic.ts` owns command expansion, spawn, timeout, output capture, and output tail. |
| Transcript rendering | `deterministic.ts` writes start, pass, skip, warning, block, output tail, summary, and fail-fast lines. |
| Exit decision | `deterministic.ts` turns blocking results into exit code 1. |

The module is not shallow for workflow callers, but it is shallow for maintainers because implementation details have weak locality.

## Scope Limits

In scope:

- Keep `runDeterministicChecks` as the external deterministic gate interface.
- Extract tool command execution after the process execution seam exists, or keep the first extraction local if this PR lands first.
- Extract transcript rendering into a focused module.
- Keep built-in policy behavior unchanged.
- Preserve terminal output unless tests are deliberately updated for equivalent wording.

Out of scope:

- Do not change tool config schema.
- Do not add new built-in policies.
- Do not change `fail_fast`, warning, blocking, or skip behavior.
- Do not change changed-file policy semantics.
- Do not change local AI sequencing.

## Proposed Files

Add:

| New file | Responsibility |
|---|---|
| `src/runner/tool-command.ts` | Expand `{changed_files}` and run one configured tool command. |
| `src/runner/transcript.ts` | Render deterministic gate output from result events. |
| `src/runner/summary.ts` | Count blocked and warning results and derive exit code if that improves locality. |

Modify:

| Existing file | Desired final role |
|---|---|
| `src/runner/deterministic.ts` | Orchestrate deterministic checks through internal modules. |
| `src/runner/policies.ts` | Keep built-in policy evaluation. |
| `test/deterministic-runner.test.ts` | Add focused tests for new internal modules where useful. |

## Proposed Module Shape

```ts
export interface DeterministicTranscript {
  writeStart(checkCount: number): void;
  writePolicyResult(result: BuiltInPolicyResult): void;
  writeToolResult(tool: ToolConfig, result: ToolResult): void;
  writeSummary(summary: DeterministicCheckSummary): void;
}
```

The exact shape can be simpler, but transcript rendering should receive deterministic results rather than recomputing policy or command behavior.

## Execution Plan

1. Extract pure summary logic.
   - Move blocked and warning counting into a small helper.
   - Keep the result type unchanged.
   - Add focused tests if current tests do not make failures obvious.

2. Extract transcript rendering.
   - Move `writeFailure`, `writePolicyResult`, final summary text, and output-tail printing into `src/runner/transcript.ts`.
   - Keep write order and text stable.
   - Pass a writable stream into the renderer rather than importing process globals.

3. Extract tool command execution.
   - Move `CHANGED_FILES_TOKEN`, `expandChangedFilesToken`, and command execution to `src/runner/tool-command.ts`.
   - If refactor 08 has landed, call the shared timed command adapter.
   - Keep deterministic-specific messages such as "command was empty" in this module.

4. Thin `runDeterministicChecks`.
   - Leave it responsible for ordering: count checks, run policies, run tools, honor fail-fast, return summary.
   - Make it read as a deterministic gate workflow rather than process and transcript implementation.

5. Validate behavior.
   - `pnpm test`
   - Targeted check: `node --import tsx --import ./scripts/register-md-loader.mjs --test test/deterministic-runner.test.ts`

## Acceptance Criteria

- `runDeterministicChecks` remains the only external deterministic gate interface used by the pre-push workflow.
- Tool command execution is isolated behind a smaller internal module.
- Transcript rendering is isolated and can be tested without spawning commands.
- Existing deterministic runner behavior and output remain stable.
- `pnpm test` passes.

## Graph Scorecard

After this PR, the deterministic gate should become a deeper module: callers keep one interface, while implementation detail moves into internal modules with better locality. Tests should cross the same public seam for workflow behavior and narrower internal seams for transcript and tool-command behavior.

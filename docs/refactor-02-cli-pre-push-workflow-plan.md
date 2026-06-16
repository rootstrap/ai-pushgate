# Refactor 02 CLI Pre-Push Workflow Plan

This document turns the CLI boundary simplification into a concrete PR plan.

The goal is to make `src/cli.ts` a real command boundary instead of the owner of the pre-push workflow. The behavior should remain identical: `pushgate hook-protocol`, `pushgate pre-push`, and `pushgate push` keep their current command contract.

## Verified Context

The generated graph marks `src/cli.ts` as a complex entry-point node. Source inspection shows it currently owns:

| Responsibility | Current location |
|---|---|
| Command dispatch and usage output | `src/cli.ts` |
| Hook stdin draining | `src/cli.ts` |
| Repository root resolution | `src/cli.ts` |
| Skip-control resolution | `src/cli.ts` |
| Config loading and warning rendering | `src/cli.ts` |
| Changed-file resolution decision | `src/cli.ts` |
| Deterministic phase orchestration | `src/cli.ts` |
| Local AI phase orchestration | `src/cli.ts` |
| Push wrapper arg parsing | `src/cli.ts` |
| Final error rendering | `src/cli.ts` |

The existing test suite already covers the important CLI behavior in `test/runner.test.ts`, `test/hook.test.ts`, and `test/support/hook-harness.ts`.

## Scope Boundaries

In scope:

- Move pre-push orchestration into a workflow module.
- Move push-wrapper argument parsing into a small CLI helper module.
- Keep `src/cli.ts` focused on argv dispatch, IO wiring, usage output, and process exit integration.
- Preserve existing error rendering and return codes.

Out of scope:

- Do not alter config, changed-file, deterministic, or AI behavior.
- Do not change hook protocol version.
- Do not change `pushgate push` flag semantics.
- Do not introduce a framework or command parser dependency.

## Proposed Files

Add:

| New file | Responsibility |
|---|---|
| `src/workflows/pre-push.ts` | End-to-end pre-push workflow orchestration |
| `src/workflows/types.ts` | Optional shared workflow IO types if they would avoid cyclic imports |
| `src/cli/push-args.ts` | Parse `pushgate push` wrapper flags |
| `src/cli/errors.ts` | Optional home for `writePushgateError` if the CLI file remains too dense |

Keep:

| Existing file | Desired final role |
|---|---|
| `src/cli.ts` | Command dispatch, usage output, IO defaults, CLI entrypoint detection |
| `src/skip-controls.ts` | Skip-control state and Git push args |
| `src/runner/deterministic.ts` | Deterministic check execution |
| `src/ai/index.ts` | Local AI review phase |

## Proposed API Shape

```ts
export interface PrePushWorkflowIO {
  env: NodeJS.ProcessEnv;
  stderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
}

export function runPrePushWorkflow(io: PrePushWorkflowIO): Promise<number>;
```

The workflow should own:

- Drain hook stdin.
- Resolve repo root.
- Resolve skip controls.
- Load config and render config warnings.
- Resolve changed files only when needed.
- Run deterministic checks.
- Run local AI review when enabled and not skipped.

The CLI should call `runPrePushWorkflow(io)` and handle thrown errors in the same way it does today.

## Execution Plan

1. Extract push wrapper parsing.
   - Move `parsePushCommandArgs` into `src/cli/push-args.ts`.
   - Add direct unit coverage only if existing runner tests do not catch the moved behavior clearly enough.

2. Extract pre-push workflow.
   - Move `runPrePush`, `runDeterministicPhase`, `runLocalAiPhase`, `maybeResolveChangedFiles`, and `drainStdin` into `src/workflows/pre-push.ts`.
   - Keep helper names close to current names to make the diff easy to review.
   - Export only `runPrePushWorkflow`.

3. Shrink `src/cli.ts`.
   - Keep `main`, `runPushCommand`, usage rendering, error rendering, and entrypoint detection.
   - Import `runPrePushWorkflow`.
   - Import `parsePushCommandArgs`.

4. Run validation.
   - `pnpm test`
   - Regenerate the Understand Anything graph and confirm `cli.ts` has fewer function nodes and fewer orchestration edges.

## Acceptance Criteria

- `pnpm test` passes.
- `src/cli.ts` no longer imports config, path-policy, deterministic runner, policy counting, or AI modules directly.
- `src/cli.ts` still owns `main` and preserves command return codes.
- `pushgate pre-push` and installed-hook smoke tests continue to pass.
- `pushgate push` flag precedence remains unchanged.

## Graph Scorecard

After this PR, `src/cli.ts` should remain in the Runtime Execution layer as the entrypoint, but the main orchestration gravity should move to `src/workflows/pre-push.ts`. The graph should show a clearer boundary between CLI dispatch and push-time workflow execution.

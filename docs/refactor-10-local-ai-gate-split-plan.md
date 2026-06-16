# Refactor 10 Local AI Gate Split Plan

This document turns the local AI gate simplification into a concrete PR plan.

The goal is to keep `runLocalAiReview` as the pre-push workflow interface while separating provider registry, guardrail checks, provider result verdicts, and terminal rendering into internal modules with better locality.

## Verified Context

`src/ai/index.ts` currently owns several concepts behind one interface.

| Concern | Current state |
|---|---|
| Public AI interface | `runLocalAiReview` is called by the pre-push workflow. |
| Provider registry | `resolveProvider` switches between Claude and Copilot adapters. |
| Guardrails | Changed-line count and prompt token estimate can skip local AI. |
| Payload construction | `buildLocalAiReviewPayload` is called from `runLocalAiReview`. |
| Provider invocation | `provider.runReview` happens directly inside `runLocalAiReview`. |
| Verdict and transcript | `handleProviderResult` writes warnings, blocks, findings, summary, and exit code. |
| Adapter seam | Claude and Copilot already prove a real provider adapter seam. |

The local AI interface has leverage for the workflow caller, but the implementation mixes too many reasons to edit.

## Scope Limits

In scope:

- Extract provider registry from `src/ai/index.ts`.
- Extract guardrail decisions into a local AI gate helper.
- Extract provider result verdict and transcript rendering.
- Keep public exports from `src/ai/index.ts` stable where tests and callers use them.
- Preserve provider adapter behavior and messages.

Out of scope:

- Do not add a new provider.
- Do not change local AI modes, max changed lines, prompt token estimation, or timeout defaults.
- Do not change the normalized AI review schema.
- Do not change prompt instructions or provider command args.
- Do not alter deterministic check sequencing.

## Proposed Files

Add:

| New file | Responsibility |
|---|---|
| `src/ai/provider-registry.ts` | Resolve provider IDs to provider adapters. |
| `src/ai/guardrails.ts` | Count changed lines, estimate prompt tokens, and return skip decisions. |
| `src/ai/verdict.ts` | Convert provider results and AI mode into exit code plus transcript events. |
| `src/ai/transcript.ts` | Render local AI review output to a writable stream. |

Modify:

| Existing file | Desired final role |
|---|---|
| `src/ai/index.ts` | Public facade and `runLocalAiReview` orchestration. |
| `src/ai/types.ts` | Add internal result or transcript event types if needed. |
| `test/ai.test.ts` | Add focused tests for guardrails and verdict behavior if existing tests are too broad. |

## Proposed Flow

```text
runLocalAiReview
  -> provider-registry
  -> guardrails
  -> buildLocalAiReviewPayload
  -> provider adapter
  -> verdict
  -> transcript
```

The pre-push workflow should still see only `LocalAiRunSummary`.

## Execution Plan

1. Extract provider registry.
   - Move `resolveProvider` into `src/ai/provider-registry.ts`.
   - Keep unknown provider behavior unchanged.
   - Keep provider adapter imports out of unrelated AI modules.

2. Extract guardrail decisions.
   - Move `countChangedLines` and `estimatePromptTokens` into `src/ai/guardrails.ts`.
   - Return explicit decisions such as `run`, `skip-no-files`, `skip-changed-lines`, or `skip-prompt-tokens`.
   - Keep output wording in transcript rendering, not guardrail calculation.

3. Extract provider result verdict.
   - Move `handleProviderResult` decision logic into `src/ai/verdict.ts`.
   - Separate "what happened" from "how it is printed".
   - Preserve exit-code behavior for blocking and advisory modes.

4. Extract transcript rendering.
   - Move finding rendering, provider failure rendering, normalization notes, and summary text into `src/ai/transcript.ts`.
   - Keep stream writes injectable for tests.

5. Thin `runLocalAiReview`.
   - Keep sequencing in `index.ts`: select provider, apply guardrails, build payload, run adapter, ask verdict/transcript modules for output and exit code.
   - Keep existing public exports from `index.ts`.

6. Validate.
   - `pnpm test`
   - Targeted checks: `test/ai.test.ts`, runner AI tests, hook AI tests.

## Acceptance Criteria

- `runLocalAiReview` remains the workflow-facing interface.
- Provider resolution is isolated behind a provider registry module.
- Guardrail logic is testable without provider stubs.
- Provider result verdicts are testable without running provider CLIs.
- Local AI terminal output and exit behavior remain stable.
- `pnpm test` passes.

## Graph Scorecard

After this PR, the local AI review module should become deeper: one workflow-facing interface hides provider selection, guardrails, verdicts, and transcript rendering. Locality improves because mode bugs, provider selection changes, and output wording no longer require editing the same implementation.

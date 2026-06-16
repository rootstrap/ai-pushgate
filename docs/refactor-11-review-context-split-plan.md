# Refactor 11 Review Context Split Plan

This document turns the review-context simplification into a concrete PR plan.

The goal is to make `src/ai/review-prompt.ts` a prompt renderer again by moving Git diff collection and full-file context collection behind a separate review context module.

## Verified Context

The review prompt module currently does more than its name suggests.

| Concern | Current state |
|---|---|
| Prompt source | `src/ai/prompts/review-prompt.md` is imported as `BASE_REVIEW_PROMPT`. |
| Prompt rendering | `renderLocalAiPrompt` formats changed files, diff, and full files. |
| Diff collection | `collectReviewDiff` runs `git diff` through `runGitChecked`. |
| Full-file collection | `collectFullFiles` reads repository files, handles deleted files, binary files, truncation, and missing files. |
| Payload assembly | `buildLocalAiReviewPayload` combines repository context and prompt rendering. |

This module is shallow by name: callers think they are using prompt code, while the implementation also owns Git and filesystem behavior.

## Scope Limits

In scope:

- Move repository context collection out of `review-prompt.ts`.
- Keep `buildLocalAiReviewPayload` exported from `src/ai/index.ts` for current tests and callers.
- Preserve prompt text and rendered prompt format.
- Preserve diff range, context line, full-file threshold, truncation, binary, deleted-file, and missing-file behavior.
- Add focused tests if context collection becomes independently testable.

Out of scope:

- Do not change provider prompt instructions.
- Do not change changed-file policy semantics.
- Do not change privacy or redaction behavior.
- Do not change prompt token budgeting.
- Do not change local AI mode behavior.

## Proposed Files

Add:

| New file | Responsibility |
|---|---|
| `src/ai/review-context.ts` | Collect diff and full-file context from a changed-file resolution. |
| `src/ai/review-context-types.ts` | Optional home for context-specific types if `types.ts` becomes noisy. |

Modify:

| Existing file | Desired final role |
|---|---|
| `src/ai/review-prompt.ts` | Render prompt text from already-collected review context. |
| `src/ai/index.ts` | Re-export payload builder and prompt renderer as today. |
| `test/ai.test.ts` | Keep payload behavior tests and add context-specific tests if useful. |

## Proposed Module Shape

```ts
export interface LocalAiReviewContext {
  changedFiles: readonly ChangedFile[];
  diff: string;
  diffLineCount: number;
  fullFiles: readonly LocalAiFullFileContext[];
}

export function collectLocalAiReviewContext(options: {
  changedFileResolution: ChangedFileResolution;
  env?: NodeJS.ProcessEnv;
  repoRoot: string;
  reviewConfig: ReviewConfig;
}): Promise<LocalAiReviewContext>;
```

`buildLocalAiReviewPayload` can then become a small composition:

```text
collectLocalAiReviewContext -> renderLocalAiPrompt -> LocalAiReviewPayload
```

## Execution Plan

1. Extract context types.
   - Reuse existing `LocalAiFullFileContext` and `LocalAiReviewPayload` where possible.
   - Add `LocalAiReviewContext` only if it clarifies the seam.

2. Move diff collection.
   - Move `collectReviewDiff` into `src/ai/review-context.ts`.
   - Keep Git command args and error message unchanged.
   - Keep `GitCommandError` handling close to Git execution.

3. Move full-file collection.
   - Move `collectFullFiles`, truncation constant, and file read handling into `review-context.ts`.
   - Preserve behavior for deleted, binary, truncated, and disappeared files.

4. Keep prompt rendering pure.
   - Leave `BASE_REVIEW_PROMPT`, `renderLocalAiPrompt`, `formatChangedFiles`, `describeChangedFile`, and `formatFullFiles` in `review-prompt.ts`.
   - Remove direct filesystem and Git imports from `review-prompt.ts`.

5. Keep payload builder stable.
   - Either leave `buildLocalAiReviewPayload` in `review-prompt.ts` as a thin composition or move it to `review-context.ts` and re-export it through `index.ts`.
   - Prefer the shape that keeps public imports stable and the module names honest.

6. Validate.
   - `pnpm test`
   - Targeted check: `test/ai.test.ts`.

## Acceptance Criteria

- `src/ai/review-prompt.ts` no longer imports Git or filesystem modules.
- Diff and full-file collection live behind a review context seam.
- Rendered prompts remain byte-for-byte compatible for existing test fixtures where asserted.
- Payload builder callers keep the same import path through `src/ai/index.ts`.
- `pnpm test` passes.

## Graph Scorecard

After this PR, prompt rendering should be a deeper formatting module and review context should concentrate Git and filesystem behavior. Locality improves because Git failures, file-reading edge cases, and prompt wording each live behind separate interfaces.

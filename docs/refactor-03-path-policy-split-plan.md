# Refactor 03 Path Policy Split Plan

This document turns the changed-file policy simplification into a concrete PR plan.

The goal is to split `src/path-policy/index.ts` by concern while keeping the public `./path-policy` export stable. This refactor should make Git range resolution, NUL-delimited diff parsing, ignore filtering, and tool-path selection easier to reason about independently.

## Verified Context

The generated graph marks `src/path-policy/index.ts` as a complex runtime node. Source inspection shows it currently mixes:

| Concern | Current examples |
|---|---|
| Public types | `ChangedFile`, `ChangedFileStatus`, `ChangedFileResolution` |
| Domain errors | `ChangedFilePolicyError`, `MissingTargetRefError`, `MissingDiffBaseError`, `GitChangedFilesError` |
| Git range resolution | `resolveTargetCommit`, `resolveDiffBase` |
| Git diff execution | `git diff --name-status -z`, `git diff --numstat -z` |
| NUL-delimited parsing | `parseChangedFiles`, `parseDiffStats`, `splitNullFields` |
| Status normalization | `normalizeGitStatus` |
| Ignore filtering | `filterIgnoredChangedFiles` |
| Tool-path selection | `selectToolChangedFilePaths`, extension matching |
| Git failure detail modeling | `gitFailure`, `gitResultDetail`, malformed output helpers |

The existing `test/path-policy.test.ts` suite exercises real Git repositories and covers filtered paths, metadata preservation, missing target refs, missing merge bases, and Git inspection failures.

## Scope Boundaries

In scope:

- Move path-policy internals into smaller modules.
- Keep `src/path-policy/index.ts` as the public facade.
- Preserve all exported type names and error classes.
- Preserve current diff-range behavior: local target ref only, no fetch, no fallback guessing.
- Preserve parser behavior for renames, copies, binary files, deleted files, and filenames with spaces.

Out of scope:

- Do not change `review.target_branch` semantics.
- Do not change ignore-path semantics.
- Do not add new changed-file statuses.
- Do not rewrite parsing around a new Git command.
- Do not move deterministic runner policy code.

## Proposed Files

Add:

| New file | Responsibility |
|---|---|
| `src/path-policy/types.ts` | `ChangedFileStatus`, `ChangedFile`, resolver options, resolution result, internal diff-stat types |
| `src/path-policy/errors.ts` | Path-policy error classes and Git/malformed-output helpers |
| `src/path-policy/git-resolution.ts` | Target commit resolution, merge-base resolution, and raw diff collection |
| `src/path-policy/diff-parsers.ts` | NUL-delimited `name-status` and `numstat` parsing |
| `src/path-policy/filtering.ts` | Ignore-path filtering and deterministic tool path selection |
| `src/path-policy/index.ts` | Public facade and `resolveChangedFiles` orchestration |

Potential dependency direction:

```text
index.ts
  -> git-resolution.ts
  -> diff-parsers.ts
  -> filtering.ts
  -> types.ts
  -> errors.ts
```

Avoid dependencies from parser modules back into resolver modules.

## Execution Plan

1. Move types first.
   - Extract public and internal types to `types.ts`.
   - Re-export public types from `index.ts`.
   - Run typecheck before moving logic.

2. Move errors.
   - Extract error classes to `errors.ts`.
   - Keep constructor messages identical.
   - Re-export public error classes from `index.ts`.

3. Move filtering.
   - Extract `filterIgnoredChangedFiles` and `selectToolChangedFilePaths`.
   - Keep these exported through `index.ts` because deterministic runner imports them today.

4. Move diff parsers.
   - Extract `parseChangedFiles`, `parseDiffStats`, and parser helper functions.
   - Export only the parser functions needed by `index.ts` or `git-resolution.ts`.
   - Keep malformed-output errors identical.

5. Move Git resolution.
   - Extract `resolveTargetCommit`, `resolveDiffBase`, and raw diff collection.
   - Reuse the shared Git helper from refactor 01 if it has landed.
   - Keep Git failure details unchanged.

6. Leave `resolveChangedFiles` in `index.ts` unless moving it to `resolver.ts` makes the facade clearer.
   - If moved, `index.ts` should still re-export it as the package's public API.

7. Run validation.
   - `pnpm test`
   - Optionally run only `tsx --test test/path-policy.test.ts` during iteration.

## Acceptance Criteria

- `pnpm test` passes.
- Public imports from `../src/path-policy/index.js` still work.
- `test/path-policy.test.ts` requires no behavior assertion changes.
- `src/path-policy/index.ts` reads as a facade plus high-level resolver, not a 500-line mixed-concern module.
- Parser code can be tested directly in a future PR without constructing Git repos.

## Graph Scorecard

After this PR, the graph should split the single complex `path-policy/index.ts` node into smaller runtime nodes. The top-level Runtime Execution layer should remain intact, but changed-file parsing and filtering should no longer be hidden behind one large file.

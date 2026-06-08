# Issue 10 Local AI Provider Interface And Claude Adapter Plan

This document narrows issue #10 into the knowledge gaps, open questions, and
execution plan for the first real local AI execution path in the v2 Pushgate
runner.

The broader product contract remains in `docs/product-contract-plan.md`. The
v2 config boundary remains in `docs/issue-2-config-schema-plan.md` and
`docs/v2-config-schema.md`. The hook and runner harness from issue #3 and the
skip-control seam from issue #18 are already in place and directly affect this
work.

## Known Context

Issue #10 owns the first provider-backed AI phase in the v2 runner:

1. Define the provider contract used by local AI review.
2. Move the first real provider invocation behind that contract.
3. Implement the Claude adapter without hard-coding Claude in the core runner.
4. Keep the deterministic runner path isolated from provider-specific logic.

The current repository state matters for this work:

| Area | Current state | Planning implication |
|---|---|---|
| AI config boundary | `.pushgate.yml` already validates `ai.mode`, `ai.provider`, and `ai.providers.<provider>` through the Node config layer. | Issue #10 should consume typed provider selection from config instead of inventing a second parser or provider-selection path. |
| Runner entry path | `src/cli.ts` resolves repo root, loads config, runs deterministic checks, and ends with `runLocalAiPhase`, which currently only handles `off` and `skip-ai-check`. | Issue #10 must replace the current no-op AI seam with a real provider contract and execution path. |
| Changed-file policy | `src/path-policy/index.ts` already returns normalized changed-file metadata, including deleted files, rename metadata, and binary markers, for deterministic and future AI consumers. | The AI layer should reuse this normalized file list instead of recomputing ad hoc Git file state. |
| Built-in review prompt | `src/ai/prompts/review-prompt.md` already holds provider-neutral review instructions and prompt-injection framing. | Prompt assembly should build on this shared artifact rather than burying instructions inside the Claude adapter. |
| Test harness | `test/runner.test.ts`, `test/hook.test.ts`, and `test/support/hook-harness.ts` already support direct runner tests, real installed-hook pushes, and `PATH` stubs. | Issue #10 can prove provider behavior with stubbed CLIs and real push smoke tests without live AI or network access. |
| Current docs | `README.md` and the product docs still describe a Claude-backed AI review step in the target workflow. | The implementation and docs need to come back into alignment so the repo does not overstate current runner behavior. |
| Historical Claude path | The older Bash hook in repo history built a diff-plus-files prompt, invoked Claude non-interactively, parsed finding blocks plus a summary, and mixed Claude-specific error handling into the hook. | Issue #10 should preserve the useful behavior while moving it behind a provider boundary and leaving room for later adapters. |

## Scope Boundaries

Issue #10 should implement the first real provider contract and the Claude
adapter that uses it. It should not silently absorb later backlog surfaces:

| Surface | Backlog owner |
|---|---|
| Local AI mode guardrails, explicit mode UX, and cost limits | Issue #11 |
| Final normalized structured findings schema and rendering contract | Issue #12 |
| GitHub Copilot provider adapter | Issue #19 |
| Additional provider families such as OpenAI-compatible or custom commands | Future follow-up |

Issue #10 may add seams those issues build on, but it should not expand into
full multi-provider product scope.

## Locked Definitions To Preserve

- `.pushgate.yml` remains the v2 config surface.
- Active local AI config selects a provider through `ai.provider` plus a
  matching `ai.providers.<provider>` block.
- `git push` remains the main developer entry point; `pushgate push` remains a
  wrapper, not a second workflow.
- Deterministic checks and local AI remain separate phases in the runner.
- `pushgate.skip-ai-check` keeps deterministic work running and bypasses only
  the local AI phase.
- The changed-file resolver stays local-only and does not fetch or guess a
  fallback diff range.
- Prompt instructions must continue treating diffs and file contents as
  untrusted data.

## Knowledge Gaps And Open Questions

### Provider Contract Boundary

- What is the smallest provider-facing input contract that still supports a
  second real adapter later: a fully rendered prompt string, a structured
  review payload, or both?
- Should the provider contract own prompt rendering, or should Pushgate build
  one provider-neutral review payload before selecting an adapter?
- What result shape should the first contract return to the runner:
  provider-specific raw text, parsed findings plus summary, or a more formal
  internal findings object that issue #12 later hardens?
- Which failure categories need first-class treatment now: missing binary,
  auth failure, non-zero exit, timeout, malformed output, or empty response?

### Claude Compatibility To Preserve

- Which historical Claude behaviors are contractually important to preserve in
  v2, and which were implementation accidents in the old Bash hook?
- Historic behavior drifted across commits: one Bash variant blocked when the
  Claude CLI was missing, while another allowed the push to continue without
  AI review. Issue #10 needs an explicit decision on which path v2 keeps for
  active AI modes.
- Should the Claude adapter preserve the old text response grammar and parse it
  into a typed internal result, or should it move immediately to a stricter
  machine-readable contract even though issue #12 owns the final output schema?
- Which Claude CLI options are required for the first adapter beyond
  non-interactive prompt execution and optional model selection?

### Review Payload Assembly

- Where should diff collection, optional full-file collection, and prompt
  assembly live so they are provider-neutral but still testable?
- Should the AI phase reuse one changed-file resolution computed before the
  deterministic phase, or re-run Git inspection just for AI input building?
- How should deleted files, binary files, renames, and `previousPath` metadata
  appear in the AI payload?
- When the diff is small enough for full-file context, should the first
  provider contract receive rendered file text, raw file objects, or both?
- Should the first payload include categories and response-format instructions
  inside the shared review prompt, or should adapters append those details?

### Mode And Failure Semantics

- Issue #11 owns the broader mode-and-guardrail product work, but issue #10
  still promises that provider failures respect the configured mode. Which
  subset lands now so the first adapter is usable without pre-empting issue
  #11?
- For `ai.mode: blocking`, which provider failures block the push versus allow
  the push with a warning?
- For `ai.mode: advisory`, should blocking findings still render with the same
  severity labels while allowing the push, or should the adapter downgrade the
  verdict itself?
- Should empty or malformed provider output count as a provider failure, a
  zero-finding pass, or an advisory warning depending on mode?

### Test And Stub Strategy

- What stub contract best exercises the first adapter: line-oriented stdout,
  saved prompt artifacts, exit-code switches, or JSON fixtures?
- How much of the old Claude prompt and response grammar should tests lock
  down now versus leaving flexible for issue #12?
- Which cases need direct runner coverage versus real installed-hook push
  coverage: pass, warning-only findings, blocking findings, missing provider,
  auth failure, malformed output, and `skip-ai-check` precedence?
- Should the harness stub capture invoked CLI args so tests can prove model
  selection and non-interactive invocation without asserting the whole prompt?

## Working Decisions For Execution

These decisions keep issue #10 implementable without pulling all later M3 work
into scope:

1. Introduce a provider-neutral TypeScript contract under `src/ai/` and keep
   provider-specific process spawning out of `src/cli.ts`.
2. Build one shared local-AI review payload from typed config plus normalized
   changed-file metadata before selecting an adapter.
3. Resolve changed files once per runner invocation and share that result
   across deterministic checks and local AI.
4. Keep the first provider result typed enough for the runner to make
   block-versus-warn decisions, but leave the final public findings schema and
   richer rendering contract to issue #12.
5. Implement the Claude adapter with a non-interactive CLI invocation path and
   optional model selection from `ai.providers.claude`.
6. Cover provider success, provider findings, and provider failure states with
   stubbed CLIs in tests; do not depend on a live Claude session.
7. Limit mode handling in issue #10 to the provider-execution semantics needed
   by the first adapter, while leaving guardrail skips, token budgets, and
   richer UX to issue #11.

## Execution Plan

1. Introduce the local AI module boundary.
   - Add provider contract types, provider error categories, and one runner
     entry point under `src/ai/`.
   - Keep `src/cli.ts` responsible only for sequencing deterministic work and
     the AI phase.

2. Refactor the pre-push runner around shared review context.
   - Resolve changed files before either deterministic or AI work.
   - Pass the normalized file list into deterministic checks and the local AI
     builder so both phases share one source of truth.
   - Replace the current `runLocalAiPhase` no-op with a real orchestration
     function that receives config, repo root, changed files, and IO.

3. Build provider-neutral AI input assembly.
   - Create helpers that collect the repo diff with configured context lines.
   - Add optional full-file collection for small changesets using
     `review.max_lines_for_full_file`.
   - Reuse `src/ai/prompts/review-prompt.md` as the base instructions and add
     the changed-files list, diff, and optional full-file context in one
     predictable format.

4. Implement the first provider contract and Claude adapter.
   - Add a Claude provider module that reads `ai.providers.claude` config.
   - Invoke Claude through a non-interactive CLI path with the rendered review
     payload and optional configured model.
   - Parse provider output into a typed internal result plus diagnostics
     instead of leaking Claude-specific parsing into the runner.
   - Classify missing-binary, auth, malformed-output, and non-zero-exit cases
     through provider errors the runner can reason about.

5. Land the first runner-level mode semantics needed by issue #10.
   - Keep `ai.mode: off` as an early skip.
   - Preserve `pushgate.skip-ai-check` as a skip that happens before provider
     invocation.
   - Make provider findings and provider failures produce explicit blocking or
     advisory runner outcomes according to the currently configured AI mode.
   - Keep the mode surface narrow enough that issue #11 can add guardrails and
     richer UX without rewriting the provider boundary.

6. Add test coverage at the provider, runner, and hook layers.
   - Add unit-level tests for prompt assembly, provider parsing, and provider
     error classification.
   - Extend `test/runner.test.ts` with stubbed Claude CLI cases for pass,
     blocking findings, warning-only findings, missing provider binary, auth
     failure, malformed output, and advisory-mode behavior.
   - Extend `test/hook.test.ts` with at least one real installed-hook push that
     proves the runner invokes the stubbed provider and respects `skip-ai-check`.
   - Keep the harness capturing CLI args and prompt artifacts so the adapter is
     observable without a live provider.

7. Align docs and examples with the implemented boundary.
   - Update `README.md` so the documented AI workflow matches the shipped
     runner behavior.
   - Keep this plan and any new comments scoped to the provider contract and
     Claude adapter, not later guardrail or Copilot work.

## Verification Target

Issue #10 is ready to close when:

1. Local AI execution flows through a provider contract instead of a
   Claude-specific branch in the core runner.
2. The Claude adapter can review the built Pushgate payload and return a typed
   result the runner consumes.
3. Deterministic checks remain isolated from provider-specific invocation code.
4. Stubbed tests cover successful review, blocking findings, warning-only
   findings, missing-provider/auth or invocation failures, and AI skip paths.
5. The implementation leaves clear seams for issue #11 mode guardrails, issue
   #12 structured findings normalization, and issue #19 Copilot support.

## Current Repo Touchpoints

| Area | Current file | Expected change |
|---|---|---|
| Runner orchestration | `src/cli.ts` | Replace the AI no-op seam with provider-backed orchestration and shared review context |
| AI prompt artifact | `src/ai/prompts/review-prompt.md` | Reuse as the provider-neutral instruction base for the first adapter |
| Changed-file resolver | `src/path-policy/index.ts` | Reuse normalized changed-file metadata and shared diff inputs for AI payload assembly |
| Config types | `src/config/types.ts` | Reuse existing provider-selection config, possibly tighten adapter-facing types |
| New AI contract | new modules under `src/ai/` | Add provider interfaces, prompt/payload builders, Claude adapter, and provider errors |
| Bundled runner | `bin/pushgate.mjs` | Rebuild after runner and AI module changes |
| Runner tests | `test/runner.test.ts` | Add provider execution, failure, and mode-aware coverage |
| Hook integration tests | `test/hook.test.ts` and `test/support/hook-harness.ts` | Add stub-provider assertions for installed-hook push flows |
| Public docs | `README.md` and this plan | Align workflow docs with the implemented AI boundary |

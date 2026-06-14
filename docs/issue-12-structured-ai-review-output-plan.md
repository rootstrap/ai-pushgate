# Issue 12 Structured AI Review Output Plan

This document narrows issue #12 into the knowledge gaps, open questions, and
execution plan for Pushgate's normalized local-AI review output.

The broader product contract remains in `docs/product-contract-plan.md`. The
v2 config boundary remains in `docs/v2-config-schema.md`. The provider
interface from issue #10 and the AI-mode guardrails from issue #11 are already
in place and directly affect this work.

## Known Context

Issue #12 owns the structured output contract that sits between provider
adapters and Pushgate's terminal rendering:

1. Define one normalized review result shape across providers.
2. Validate provider output predictably.
3. Add safe repair or fallback behavior for malformed output.
4. Keep terminal rendering provider-neutral.

The current repository state matters for this work:

| Area | Current state | Planning implication |
|---|---|---|
| Output parser | `src/ai/review-output.ts` parses a custom line-oriented `FINDING` / `SUMMARY` text grammar and validates counts plus verdict consistency. | Issue #12 should replace or wrap this parser with the canonical normalized schema path instead of adding a second ad hoc parser per provider. |
| Internal types | `src/ai/types.ts` defines `AiFinding` with `category`, `severity`, `file`, `line`, `message`, and `suggestion`, but not confidence or source metadata. | The normalized result contract needs to harden these types and freeze which fields are required. |
| Prompt contract | `src/ai/prompts/review-prompt.md` already preserves prompt-injection framing and fixed review categories, but still asks providers to emit text blocks rather than JSON. | Issue #12 should keep the untrusted-data framing while updating only the response contract. |
| Runner rendering | `src/ai/index.ts` already renders findings from typed data rather than printing provider-specific success text. | The new schema should keep this provider-neutral rendering path and avoid pushing raw provider text into the runner. |
| Provider adapter | `src/ai/providers/claude.ts` invokes Claude with `--output-format text`, parses provider stdout directly, and treats malformed output as `invalid_output` with no repair path. | Issue #12 should keep provider failures explicit while defining what minimal repair is safe before falling back to `invalid_output`. |
| Existing tests | `test/ai.test.ts` and `test/runner.test.ts` currently lock the text-block grammar, `--output-format text`, and current terminal wording. | The work should update fixtures and coverage around the normalized schema rather than keeping the old text grammar as contract. |
| Existing docs | `docs/v2-config-schema.md` says blocking and warning categories must stay aligned with the later structured findings layer, but no dedicated issue-12 plan exists yet. | This issue should freeze the normalized findings contract without reopening the v2 config surface. |

## Scope Boundaries

Issue #12 should implement the normalized findings schema, validation path, and
provider-neutral rendering contract. It should not silently absorb adjacent
backlog surfaces:

| Surface | Backlog owner |
|---|---|
| Provider interface and Claude adapter boundary | Issue #10 |
| AI modes, guardrails, and skip behavior | Issue #11 |
| GitHub Copilot adapter | Issue #19 |
| Config-schema extensions for project-specific AI prompt overrides | Future follow-up |
| Broader privacy/redaction product policy | Future follow-up |

Issue #12 may add seams those later tasks consume, but it should not expand
into new provider families, new config vocabulary, or a second AI phase.

## Locked Definitions To Preserve

- `.pushgate.yml` remains the v2 config surface.
- `git push` remains the primary developer entry point.
- Deterministic checks and local AI remain separate phases in the runner.
- `pushgate.skip-ai-check` still bypasses only the AI phase.
- The changed-file resolver and full-file payload builder remain provider-neutral
  shared inputs for local AI.
- Prompt instructions must continue treating diffs and file contents as
  untrusted data.
- Blocking and warning category semantics must stay aligned with the v2 review
  prompt and terminal behavior.

## Knowledge Gaps And Open Questions

### Canonical Schema Boundary

- What is the canonical normalized object shape: findings only, or findings plus
  an explicit summary envelope with provider metadata?
- Should verdict and blocking/warning counts still be provider-authored, or
  should Pushgate derive them from validated findings to reduce provider
  fragility?
- Should `line` stay a string to preserve values like `3-4` and `N/A`, or
  should the normalized contract split locations into structured numeric fields?
- Where should schema versioning live: a TypeScript-only contract, a JSON schema
  artifact in the repo, or both?

### Taxonomy And Field Semantics

- Should the current five category strings become frozen TypeScript unions and
  strict schema enums in this issue?
- Is `severity` a provider-authored field that must be validated, or a runner
  derived field based on category policy?
- What confidence vocabulary is stable enough to freeze now: `low|medium|high`,
  numeric bands, or optional free text?
- What exact provider/source metadata is required for the first normalized
  schema: provider only, provider plus model, or a fuller provenance object?

### Validation And Repair Strategy

- What counts as safe repair for malformed output: extracting a fenced JSON
  block, trimming leading prose, or repairing common key-shape drift?
- Should repair operate on the whole review object only, or can Pushgate keep
  valid findings while dropping invalid ones?
- When schema validation fails, should Pushgate surface just the first error or
  a collected list of actionable diagnostics?
- How much raw provider output should remain visible in failure cases without
  making local terminal output noisy or leaking too much model chatter?

### Rendering Contract

- Should the terminal output show confidence or provider metadata, or keep the
  current concise finding transcript and use metadata only for diagnostics?
- If the normalized contract allows provider-authored summary text later, where
  should that live without replacing Pushgate's own exit-code and blocking
  decisions?
- Should repaired output print an explicit note so teams know the provider did
  not match the strict schema on the first try?
- Should category-to-label mapping stay exactly `BLOCK` / `WARN`, or should the
  rendering layer adopt richer headings once confidence exists?

### Future Provider Compatibility

- Should provider adapters return raw stdout for normalization in shared core
  code, or continue returning already-parsed review objects after using a shared
  validator?
- What contract shape best supports issue #19 so Copilot can plug into the same
  normalized findings path without another rendering branch?
- Should adapters be allowed to add provider-specific metadata now, or should
  the first normalized schema reject unknown metadata keys to stay tight?
- How should unsupported future categories behave: reject the whole review, or
  map them to an explicit fallback category only if that fallback is documented?

### Verification And Fixtures

- Should tests lock down exact JSON fixture payloads, or validate behavior using
  representative fixtures plus schema-validation assertions?
- Which repair cases are contract-level and worth supporting deliberately, and
  which malformed outputs should fail fast as provider errors?
- Which scenarios need direct parser tests versus runner or hook integration:
  strict success, repairable success, unrepairable output, advisory findings,
  blocking findings, and provider failure diagnostics?
- Should test fixtures include future-provider samples now, or keep issue #12
  focused on the shared contract plus Claude-backed execution?

## Working Decisions For Execution

These decisions keep issue #12 implementable without reopening the broader M3
scope:

1. Define one canonical normalized review result in shared core code and make
   provider adapters conform to it.
2. Keep the current category vocabulary from the built-in review prompt and
   freeze it into strict enums rather than free strings.
3. Keep `line` as a string for now so ranges and `N/A` remain first-class
   without inventing a richer location schema mid-stream.
4. Add `confidence` as a required normalized enum and keep the first version
   intentionally small, such as `low`, `medium`, and `high`.
5. Move to a JSON response contract for provider output while preserving the
   existing prompt-injection and untrusted-data framing.
6. Let Pushgate compute canonical blocking and warning counts from validated
   findings, even if the provider also returns a summary object.
7. Allow only narrow repair steps that do not invent or rewrite findings:
   trimming wrapper prose, extracting a fenced JSON block, and normalizing one
   top-level object shape before schema validation.
8. Keep terminal rendering driven from normalized findings and summary counts in
   `src/ai/index.ts`, not from provider-specific success text.

## Execution Plan

1. Freeze the normalized review schema.
   - Introduce strict TypeScript types for findings, confidence, provider
     metadata, and the top-level normalized review result under `src/ai/`.
   - Add a repo-visible schema reference if it materially improves validation
     clarity or fixture readability.
   - Keep the contract provider-neutral and avoid adding new `.pushgate.yml`
     settings for this issue.

2. Replace the current text-block output contract with JSON.
   - Update `src/ai/prompts/review-prompt.md` and `src/ai/review-prompt.ts` so
     providers are instructed to return one JSON object only.
   - Preserve the existing focus areas, category vocabulary, and prompt
     injection wording.
   - Decide whether provider-authored summary fields remain required or become
     optional diagnostics because Pushgate can derive them.

3. Implement shared normalization, validation, and repair.
   - Refactor `src/ai/review-output.ts` into a shared normalization pipeline.
   - Parse strict JSON first, then attempt only the explicitly supported repair
     steps before returning `AiReviewOutputError`.
   - Validate required fields, enum values, summary consistency where retained,
     and provider/source metadata presence.

4. Route provider adapters through the normalized contract.
   - Update `src/ai/providers/claude.ts` to request the new JSON contract and
     pass provider stdout through the shared normalization layer.
   - Preserve missing-binary, timeout, auth, empty-output, and malformed-output
     failure categories.
   - Keep provider-specific invocation and shared output normalization separate.

5. Keep runner-level rendering provider-neutral.
   - Update `src/ai/index.ts` to consume the hardened normalized types.
   - Decide whether confidence and provider metadata change the user-facing
     transcript or remain internal/diagnostic data.
   - Preserve existing blocking versus advisory exit behavior from issue #11.

6. Expand tests around the contract.
   - Replace the current text-format parser fixtures in `test/ai.test.ts` with
     strict JSON fixtures plus repairable and invalid-output cases.
   - Update runner tests so blocking and advisory flows prove the normalized
     output path instead of Claude-specific text parsing.
   - Keep at least one end-to-end stubbed provider test that proves the prompt
     and adapter use the new response format.

7. Align docs with the normalized contract.
   - Update `README.md` and `docs/v2-config-schema.md` where they describe the
     structured findings layer.
   - Keep documentation focused on the normalized output boundary and leave
     later provider additions to their own issue plans.

## Verification Target

Issue #12 is ready to close when:

1. A shared normalized AI review schema exists and is the only supported
   provider-result contract.
2. Provider output is validated predictably, with explicit repair or fallback
   behavior for malformed output.
3. Terminal rendering uses normalized findings instead of provider-specific
   transcripts.
4. Tests cover strict success, repairable success, invalid output, advisory
   findings, and blocking findings through the shared contract.
5. Docs explain the normalized output boundary without reopening unrelated M3
   surfaces.

## Current Repo Touchpoints

| Area | Current file | Expected change |
|---|---|---|
| Shared AI result types | `src/ai/types.ts` | Harden findings and provider metadata into the canonical normalized contract |
| Output parsing and validation | `src/ai/review-output.ts` | Replace text-block parsing with shared JSON normalization and repair |
| Prompt contract | `src/ai/prompts/review-prompt.md`, `src/ai/review-prompt.ts` | Instruct providers to return one strict JSON object while preserving untrusted-data framing |
| Claude adapter | `src/ai/providers/claude.ts` | Request and validate the new normalized output contract |
| Runner rendering | `src/ai/index.ts` | Keep provider-neutral terminal output using the hardened types |
| AI tests | `test/ai.test.ts` | Replace text fixtures with normalized JSON success, repair, and failure coverage |
| Runner and hook tests | `test/runner.test.ts`, `test/hook.test.ts` | Prove blocking and advisory behavior still flows through normalized findings |
| Docs | `README.md`, `docs/v2-config-schema.md` | Align structured-findings wording with the implemented schema |

# Issue 19 GitHub Copilot Provider Adapter Plan

This document narrows issue #19 into the knowledge gaps, open questions, and
execution plan for adding GitHub Copilot as the second real local AI provider
adapter in Pushgate.

The broader product contract remains in `docs/product-contract-plan.md`. The
v2 config boundary remains in `docs/v2-config-schema.md`. The local AI provider
interface from issue #10, mode guardrails from issue #11, and normalized
structured output contract from issue #12 are already in place and directly
shape this work.

GitHub's current documentation points to the standalone `copilot` CLI as the
supported path for command-line Copilot usage. The retired `gh copilot`
extension should not be the implementation target. Relevant docs checked on
2026-06-14:

- [Running GitHub Copilot CLI programmatically](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically)
- [GitHub Copilot CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
- [Authenticating GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)
- [Using the GitHub CLI Copilot extension](https://docs.github.com/en/copilot/how-tos/use-copilot-for-common-tasks/use-copilot-in-the-cli)

## Known Context

Issue #19 owns the first non-Claude provider adapter:

1. Add a GitHub Copilot adapter behind the existing `LocalAiProviderAdapter`
   contract.
2. Let `.pushgate.yml` select Copilot through the existing v2 provider
   extension point.
3. Invoke Copilot non-interactively and map its response through the normalized
   Pushgate JSON review-output path.
4. Preserve local AI mode behavior for provider failures and findings.
5. Prove the adapter through stubs, without requiring a live Copilot session.

The current repository state matters for this work:

| Area | Current state | Planning implication |
|---|---|---|
| Provider boundary | `src/ai/types.ts` defines `LocalAiProviderAdapter`, `LocalAiProviderRunOptions`, provider failure codes, and normalized review result types. | Copilot should implement the existing adapter interface rather than adding a parallel AI path. |
| Provider selection | `src/ai/index.ts` currently resolves only `claude` and reports `unsupported_provider` for anything else. | Issue #19 can be small if it adds a Copilot adapter and registers it in `resolveProvider`. |
| Config schema | `schemas/pushgate-config-v2.schema.json` allows arbitrary provider keys below `ai.providers.<provider>`, while `src/config/index.ts` only requires the selected provider block to exist. | Selecting `provider: copilot` should already validate without a schema enum change, but docs/templates should show the supported block. |
| Prompt and payload | `src/ai/review-prompt.ts` builds one provider-neutral prompt from changed files, diff, and optional full-file context. | Copilot should consume the same payload as Claude and must not recompute changed files or couple itself to deterministic checks. |
| Output normalization | `src/ai/review-output.ts` parses, repairs, validates, and summarizes the strict Pushgate JSON output schema. | Copilot stdout should go through `parseAiReviewOutput` with `provider: "copilot"` source metadata. |
| Claude adapter | `src/ai/providers/claude.ts` handles spawn errors, timeouts, non-zero exits, auth detection, empty output, and malformed output. | Copilot should mirror this behavior, but the command, auth signals, and args are provider-specific. |
| Tests | `test/ai.test.ts` already stubs a provider binary, captures args and prompt input, and verifies timeout behavior. | The Copilot adapter can use the same style of direct adapter tests and runner-level tests without a real model. |
| Local environment | The current development machine does not have the standalone `copilot` binary installed, and `gh extension list` does not include the retired Copilot extension. | Implementation and verification should rely on official docs plus stubs, not local live Copilot behavior. |

## Scope Boundaries

Issue #19 should implement the Copilot provider adapter and the minimum docs and
tests needed to make it usable. It should not silently absorb adjacent backlog:

| Surface | Backlog owner |
|---|---|
| New provider interface shape | Already owned by issue #10; change only if Copilot exposes a real flaw |
| Local AI mode semantics and guardrail policy | Already owned by issue #11 |
| Normalized review schema, taxonomy, and repair policy | Already owned by issue #12 |
| Custom command, OpenAI-compatible, or BYOK providers | Future follow-up |
| CI/PR enforcement or remote Copilot code review | Future follow-up |

## Locked Definitions To Preserve

- `.pushgate.yml` remains the v2 config surface.
- Active local AI config selects a provider through `ai.provider` plus a
  matching `ai.providers.<provider>` block.
- Deterministic checks and local AI remain separate phases.
- `pushgate.skip-ai-check` bypasses only local AI and keeps deterministic work
  running.
- The changed-file resolver stays provider-neutral and local-only.
- Copilot output must normalize through the same Pushgate JSON review schema as
  Claude output.
- Prompt instructions must continue treating diffs and file contents as
  untrusted data.

## Knowledge Gaps And Open Questions

### Copilot CLI Invocation Path

- Should the adapter send the rendered Pushgate prompt through stdin or through
  `copilot -p/--prompt`? The docs support both, but Pushgate prompts can be
  large, so stdin is likely safer than command-line args.
- Should Pushgate use plain prompt mode with the existing provider-neutral
  review instructions, or Copilot's built-in `/review` slash command? The
  adapter should probably keep Pushgate's normalized schema prompt in control,
  because `/review` may produce Copilot-native review output instead of the
  Pushgate JSON contract.
- Which options are required for stable non-interactive behavior:
  `-s/--silent`, `--no-ask-user`, `--stream=off`, `--model`, `--add-dir`, and
  read-only tool restrictions all need adapter-level decisions.
- Should the adapter request Copilot CLI's `--output-format=json`? Current docs
  describe that as JSONL session output, not necessarily the agent's raw
  Pushgate JSON response, so the first implementation should likely keep text
  output and parse the response body.

### Repository Access And Tool Permissions

- Should Copilot be allowed to read repository files, matching the current
  Claude adapter's read-only repository access, or should the first adapter be
  payload-only?
- If read access is allowed, which Copilot tool controls map cleanly to
  read-only review: `--add-dir=<repoRoot>`, `--available-tools=view,grep,glob`,
  and `--allow-tool=read` look like the safest initial shape, but this should
  be verified against `copilot help` once a real binary is available.
- How should Pushgate avoid accidental writes, shell execution, URL access, MCP
  use, or repository-controlled prompt-mode extensions during a local pre-push
  review?
- Does Copilot CLI require a trusted-directory prompt in non-interactive mode,
  and can `--add-dir` plus explicit tool restrictions avoid blocking on user
  interaction?

### Provider Config Shape

- Is `ai.providers.copilot.model` enough for the first provider-specific config,
  or should the adapter also expose command path, extra args, permission mode,
  or repository-read toggles?
- Should `model` map only to `--model` when set, leaving Copilot's default or
  `COPILOT_MODEL` environment variable otherwise?
- Should docs recommend `provider: copilot` in examples while leaving templates
  on Claude by default until Copilot CLI behavior is proven in real use?
- Should unsupported provider-specific fields be ignored, surfaced as warnings,
  or left alone because provider config is intentionally an extension object?

### Auth And Failure Classification

- Is there a stable Copilot CLI command for auth status, or should the adapter
  classify `not_authenticated` from non-zero prompt-mode output patterns?
- Which auth paths should docs mention: `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`,
  `GITHUB_TOKEN`, stored Copilot OAuth login, and the GitHub CLI fallback all
  exist, but token precedence can surprise users.
- How should organization policy failures, missing Copilot subscription,
  disabled Copilot CLI policy, and unsupported model names map onto existing
  failure codes: `not_authenticated`, `command_failed`, or a new code?
- Should model-not-available errors get a dedicated failure code, or stay
  `command_failed` with clear provider output?

### Output Normalization

- How reliable is Copilot at returning only the requested JSON object when run
  with `-s` and `--no-ask-user`?
- Should the shared repair path be enough for Copilot wrapper prose and fenced
  JSON, or does Copilot need provider-specific cleanup before
  `parseAiReviewOutput`?
- Should Copilot source metadata include only `provider` and optional `model`,
  or should it preserve CLI version/session details somewhere later?
- How much provider output should be surfaced on malformed output without
  making local terminal output noisy?

### Test Strategy

- What stub behavior best captures Copilot's CLI surface: stdin capture, argv
  capture, successful JSON stdout, stderr plus non-zero exit, timeout, and
  auth-like failure output?
- Should direct adapter tests assert every Copilot arg, or only the
  contract-level args that matter for non-interactive behavior, model
  selection, prompt delivery, and tool restrictions?
- Which cases need runner tests in addition to direct adapter tests: provider
  selection, blocking failure, advisory failure, unsupported provider fallback,
  and successful normalized findings?
- Should hook tests add one installed-hook smoke path for `provider: copilot`,
  or is direct runner coverage sufficient because the hook only delegates?

## Working Decisions For Execution

These decisions keep issue #19 implementable without reopening the broader M3
scope:

1. Implement `src/ai/providers/copilot.ts` as a sibling to the Claude adapter
   and register it in `resolveProvider`.
2. Target the standalone `copilot` binary, not the retired `gh copilot`
   extension.
3. Feed the existing rendered Pushgate prompt to Copilot through stdin to avoid
   command-line length limits.
4. Start with text output capture (`-s/--silent`) and parse the agent response
   through `parseAiReviewOutput`, rather than consuming Copilot JSONL session
   output.
5. Pass `--no-ask-user` and `--stream=off` for predictable non-interactive
   runs.
6. Preserve parity with Claude by running Copilot from the repo root with
   read/search tools available, while explicitly denying or excluding write,
   shell, URL, MCP, custom-instruction, remote-session, and ask-user behavior.
7. Keep provider config narrow for the first adapter: support optional
   `ai.providers.copilot.model` and avoid new public config for custom args.
8. Use existing provider failure codes unless implementation reveals a clear
   missing category.
9. Prove behavior entirely with stubbed `copilot` binaries and captured stdin
   or args; do not require a live Copilot account in tests.

## Execution Plan

1. Add the Copilot provider adapter.
   - Create `src/ai/providers/copilot.ts`.
   - Mirror the Claude adapter's process-spawn structure, timeout handling,
     output capture limits, and provider-result mapping.
   - Invoke `copilot` non-interactively with silent output, no user questions,
     optional model selection, and read/search-only tool restrictions.
   - Send `options.payload.prompt` through stdin.

2. Register provider selection.
   - Update `src/ai/index.ts` so `resolveProvider("copilot")` returns the new
     adapter.
   - Keep unsupported-provider behavior unchanged for unknown provider IDs.
   - Pass `ai.providers.copilot` as the provider config when Copilot is
     selected.

3. Normalize Copilot responses through the shared output path.
   - Trim Copilot stdout and treat empty output as `empty_output`.
   - Parse stdout with `parseAiReviewOutput(rawOutput, { provider: "copilot",
     model })`.
   - Preserve normalization notes and provider-neutral terminal rendering.
   - Return `invalid_output` when the shared parser rejects the response.

4. Classify Copilot failures.
   - Map spawn `ENOENT` to `missing_binary` with installation guidance for the
     standalone Copilot CLI.
   - Map timeout to `timed_out` using `ai.timeout_seconds`.
   - Detect obvious auth or access failures from non-zero output and map them
     to `not_authenticated` where the message is clear.
   - Keep other non-zero exits as `command_failed`, including unsupported model
     and organization-policy errors unless a more stable signal exists.

5. Extend tests.
   - Add direct AI tests that stub `copilot`, capture stdin, and assert success
     through normalized JSON findings.
   - Assert optional `model` becomes `--model=<model>` or equivalent documented
     args.
   - Add tests for missing binary, timeout, empty output, malformed output, and
     auth-like non-zero output.
   - Add runner-level tests proving `.pushgate.yml` can select Copilot and that
     blocking/advisory mode behavior matches the existing provider contract.
   - Keep tests independent from a live Copilot session.

6. Update docs and examples.
   - Update `README.md` requirements and config examples to mention Copilot CLI
     as a supported provider.
   - Update `docs/v2-config-schema.md` with the Copilot provider block and any
     provider-specific notes.
   - Update `templates/base.yml` to show a commented Copilot example if the
     current hint needs corrected model or auth wording.
   - Avoid making Copilot the default provider in templates until it has real
     adapter usage feedback.

7. Rebuild generated artifacts and run verification.
   - Rebuild `bin/pushgate.mjs` if the repository's build process requires the
     bundled runner to stay in sync.
   - Run the targeted AI/config/runner tests first.
   - Run the full test suite before opening a PR.
   - Optionally run a manual stubbed `pushgate pre-push` smoke test with
     `provider: copilot` if test output leaves any invocation uncertainty.

## Verification Target

Issue #19 is ready to close when:

1. `.pushgate.yml` can select `ai.provider: copilot` with a matching
   `ai.providers.copilot` block.
2. Pushgate invokes the standalone Copilot CLI through a non-interactive,
   testable adapter.
3. Copilot output is normalized through the existing Pushgate JSON review
   schema and provider-neutral renderer.
4. Missing binary, timeout, auth-like, command failure, empty output, and
   malformed output paths respect `blocking` and `advisory` AI modes.
5. Tests prove Copilot adapter behavior without requiring a live Copilot CLI
   session.
6. Docs explain installation, auth, config, and current adapter limits clearly.

## Current Repo Touchpoints

| Area | Current file | Expected change |
|---|---|---|
| Provider registry | `src/ai/index.ts` | Register the `copilot` adapter in provider resolution |
| New provider | `src/ai/providers/copilot.ts` | Add standalone Copilot CLI invocation, failure mapping, and output normalization |
| Provider types | `src/ai/types.ts` | Likely no change; add only if Copilot exposes a missing failure category |
| Output parser | `src/ai/review-output.ts` | Likely no change; reuse shared JSON normalization |
| Config schema | `schemas/pushgate-config-v2.schema.json` | Likely no schema change; provider config is already an extension object |
| Config tests | `test/config.test.ts` | Add or adjust coverage showing `provider: copilot` validates with a matching block |
| AI tests | `test/ai.test.ts` | Add Copilot stub success, args/stdin capture, failure, timeout, and invalid-output coverage |
| Runner tests | `test/runner.test.ts` | Add provider-selection and mode-behavior coverage for Copilot |
| Public docs | `README.md`, `docs/v2-config-schema.md`, `templates/base.yml` | Document Copilot install/auth/config and keep examples provider-neutral where possible |
| Bundled runner | `bin/pushgate.mjs` | Rebuild after source changes in the implementation phase |

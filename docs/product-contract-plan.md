# Pushgate Product Contract And Plan

This document captures the product definition to make implementation work concrete before the hook and `pushgate` command are rewritten.

## Contract

Pushgate fits the normal developer Git workflow:

1. A developer runs `git push`.
2. Git invokes the installed `pre-push` hook.
3. The hook delegates to `pushgate pre-push` and returns its exit code.
4. Pushgate runs configured local deterministic checks and local AI in the configured mode.
5. CI and PR checks enforce policy that must not depend on a local hook.

`pushgate push` may wrap `git push` for convenience, but it is not the required path. It must preserve the same behavior as Git and use one-command Git config when it adds Pushgate-specific skip flags:

```bash
git -c pushgate.skip-ai-check=true push
git -c pushgate.skip-all-checks=true push

pushgate push --skip-ai-check
pushgate push --skip-all-checks
```

Native `git push --no-verify` remains the broad bypass because Git does not invoke `pre-push` for that command. The public contract should make that limitation clear instead of implying local hooks are final enforcement.

The primary project config is `.pushgate.yml`. Any `.push-review.yml` support is a migration concern and should not define the new public vocabulary.

`pushgate pre-push` is part of Pushgate, not a separate product or user-facing dependency. The implementation question is how the installed hook finds the Pushgate command once the hook delegates work out of the current single Bash script.

## Defaults

| Surface | Default contract |
|---|---|
| Developer entry point | `git push` |
| Hook behavior | Delegate to `pushgate pre-push` |
| Config filename | `.pushgate.yml` |
| Local deterministic checks | Run only when configured; blocking checks may stop a push |
| Local AI | `blocking` by default; `advisory` and `off` are supported |
| Final enforcement | CI and PR policy, not the local hook |
| Whole-hook skip | `git push --no-verify` or one-command `pushgate.skip-all-checks` |
| AI-only skip | one-command `pushgate.skip-ai-check` |

## Knowledge Gaps And Open Questions

### Pushgate Command And Distribution

- Choose the runtime and distribution form for the `pushgate` command: packaged script, standalone binary, package-manager install, or a hybrid.
- Decide whether the installer installs Pushgate, only locates `pushgate` already on `PATH`, or supports both.
- Define the missing-command behavior for the installed hook. A local hook should fail clearly if a blocking Pushgate policy cannot run.
- Decide how command version compatibility is checked between the installed hook, config schema, and templates.

### Hook Integration

- Define the exact `pre-push` interface passed from the thin hook to `pushgate pre-push`, including hook arguments and stdin ref lines from Git.
- Decide how installation composes with an existing `pre-push` hook after the current backup behavior. Backup-only is simple, but composition may be necessary for adoption.
- Decide whether `core.hooksPath`, worktrees, nested repos, and monorepo subdirectory invocation are supported in the first Pushgate command design.
- Decide whether `pushgate pre-push` is an internal hook entry point only or a supported command users can run manually for debugging.

### Config And Migration

- Freeze the `.pushgate.yml` schema shape before implementation: top-level sections, typed command syntax, defaults, validation errors, and extension points.
- Decide whether command checks require argv arrays, allow a shell escape hatch, or support both with explicit safety semantics.
- Define which config fields are required versus defaulted for base ref, changed-file filtering, fail-fast behavior, timeouts, check modes, and AI mode.
- Decide the compatibility contract for `.push-review.yml`: detection only, one-time migration, compatibility adapter, warning period, or hard failure with guidance.
- Decide whether templates are schema examples only or stack-specific recommended policies with CI mirror guidance.

### Skip Controls

- Define precedence between `git push --no-verify`, one-command Git config, repo/global Git config, any environment-variable aliases, and config file policy.
- Decide whether persistent `git config pushgate.skip-*` values are supported or rejected in favor of one-command overrides.
- Decide whether the implementation keeps environment aliases for automation even though the public developer examples use Git's temporary config channel.
- Define output for each skip path so a skipped local policy is visible without becoming noisy.

### Local Checks

- Define the base-ref algorithm when the configured target branch is absent locally, a push creates a new branch, or a remote ref differs from local history.
- Freeze changed-file semantics for deleted files, renames, binary files, generated files, ignored paths, extension filters, and filenames with whitespace.
- Decide check mode defaults and failure handling for missing commands, timeouts, warnings, fail-fast, and checks that must run on the whole repo.
- Define which local blocking checks must have a CI mirror and how local-only exceptions are recorded.

### AI Policy

- Keep the local modes explicit: `blocking` is the default and preserves the review gate; `advisory` and `off` are supported softer modes.
- Define findings and provider failure behavior for `blocking`, `advisory`, and `off`.
- Define provider inputs, normalized findings, timeouts, error handling, and auth detection without coupling Pushgate to one provider.
- Set privacy rules before implementation sends diffs or full files: redaction, secret handling, context limits, provider disclosure, and auditability.
- Decide cost and latency guardrails, including changed-line limits, prompt limits, provider timeouts, and user-visible skip messages.

### CI And PR Enforcement

- Define which local deterministic checks can be mirrored in CI and whether Pushgate emits GitHub Actions workflow files or only validates parity first.
- Define the boundary between local advisory AI and CI/PR AI risk classification.
- Decide how branch protection guidance, check summaries, annotations, artifacts, and PR comments enter the product contract.

### Support And Verification

- Freeze supported platforms and shells before choosing parser, timeout, path glob, and packaging implementations.
- Build a test harness that creates temporary Git repos and stubs checks and AI providers before moving behavior out of the existing Bash hook.
- Decide migration and release messaging for old repository names, old config files, old hook output prefixes, and existing install URLs.

## Execution Plan

1. Freeze the decisions needed by the Pushgate command and config parser.
   - Choose runtime/distribution, hook composition, skip precedence, `.pushgate.yml` schema shape, and `.push-review.yml` migration behavior.
   - Turn the agreed schema and product defaults into fixtures and validation examples before behavior changes.

2. Add verification scaffolding around the current repo.
   - Create integration tests with temporary Git repos, fake remote refs, command stubs, and provider stubs.
   - Cover Git hook stdin/args, filenames with spaces, ignored paths, skipped paths, missing dependencies, warnings, and blocking exits.
   - Add shell syntax/static checks for the remaining shell entry points.

3. Introduce the Pushgate command boundary.
   - Replace the installed `hook/pre-push` body with a small delegator to `pushgate pre-push`.
   - Preserve install backup behavior and make missing-command or incompatible-command errors actionable.
   - Keep `git push` as the primary path and add `pushgate push` only as a wrapper over Git.

4. Move config and deterministic policy into `pushgate pre-push`.
   - Parse and validate `.pushgate.yml` with typed internal data instead of grep/awk YAML parsing.
   - Add the migration adapter or migration guidance chosen for `.push-review.yml`.
   - Implement changed-file resolution, path filtering, command check modes, timeouts, and skip config handling.

5. Add local AI behind the deterministic path.
   - Implement provider isolation, blocking default behavior, normalized findings, privacy guardrails, and AI-only skip handling.
   - Make provider failure behavior explicit for each AI mode.

6. Establish enforceable CI/PR policy.
   - Add CI parity reporting or generation for local blockers.
   - Add CI/PR AI behavior only after privacy rules and normalized output are stable.

7. Finish migration-facing docs and templates.
   - Update template configs, install instructions, output naming, contributing guidance, and release notes around the final public vocabulary.
   - Keep README focused on the contract and direct deeper implementation notes to dedicated docs.

## Current Repo Touchpoints

| Area | Current file | Expected change |
|---|---|---|
| Public docs | `README.md` | Describe the Pushgate contract, `.pushgate.yml`, and scoped skip commands |
| Hook entry point | `hook/pre-push` | Become a thin delegator to `pushgate pre-push` |
| Installer | `install.sh` | Install the hook/config and handle Pushgate command discovery or distribution |
| Templates | `templates/*.yml` | Move to the frozen `.pushgate.yml` schema and new defaults |
| Existing compatibility | current `.push-review.yml` parsing in `hook/pre-push` | Move behind the chosen migration behavior |
| Tests | none yet | Add temporary-repo integration coverage before large behavior moves |

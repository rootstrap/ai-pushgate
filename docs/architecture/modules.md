# Pushgate Module Map

This map uses the codebase-design vocabulary: a module exposes an interface and
hides an implementation. The useful question is what callers do not need to
know.

## Runtime Modules

| Module | Main interface | Implementation files | Notes |
|---|---|---|---|
| Hook delegator | Executable Git `pre-push` hook plus hook protocol check | `hook/pre-push` | Small by design. It should stay a delegator. |
| Installer | `install.sh [--template name]` | `install.sh`, `templates/*.yml` | Owns runner placement, hook backup, template install, and validation. |
| CLI | `main(argv, io)` and `pushgate` subcommands | `src/cli.ts`, `src/cli/*` | Public command surface for hook and wrapper use. |
| Pre-push workflow | `runPrePushWorkflow(io)` | `src/workflows/pre-push.ts`, `src/workflows/run-decisions.ts` | Owns phase order and warning confirmation. |
| Config | `loadConfig`, `parseConfigYaml`, `PushgateConfig` | `src/config/*`, `schemas/pushgate-config-v2.schema.json` | Converts user YAML into one normalized internal shape. |
| Path policy | `resolveChangedFiles`, `selectToolChangedFilePaths` | `src/path-policy/*`, `src/git/*` | Owns Git range, diff parsing, ignore, and live-path semantics. |
| Process execution | `runCommand`, `runTimedCommand`, `runProcessOutcome`, `runInheritedCommand` | `src/process/*` | Shared child-process mechanics and outcome formatting. |
| Deterministic runner | `runDeterministicChecks` | `src/runner/*` | Runs built-in policies, plugin checks, configured tools, transcript, and summary. |
| Local AI review | `runLocalAiReview` | `src/ai/*` | Applies guardrails, builds payload, calls provider runtime, builds verdict. |
| Provider adapters | `LocalAiProviderAdapter.runReview` | `src/ai/providers/*` | Isolates Claude and Copilot command and transport details. |
| Generated runner | Executable `bin/pushgate.mjs` | `bin/pushgate.mjs`, `scripts/build-runner.mjs` | Installer-facing artifact; source of truth remains `src/`. |

## Data Contracts

| Contract | Producer | Consumers | Important invariants |
|---|---|---|---|
| `PushgateConfig` | Config module | Workflow, runner, AI, path policy | Defaults are normalized; active AI modes require a selected provider block. |
| `ChangedFileResolution` | Path policy | Deterministic runner, local AI | Contains target ref, target commit, merge base, filtered files, review range, and scan range. |
| `ChangedFile` | Path policy | Policies, tools, AI payload builder | Includes status, optional previous path, binary marker, additions, and deletions. |
| `ToolResult` | Deterministic runner | Transcript and summary | Status is `passed`, `skipped`, `warning`, or `blocked`. |
| `LocalAiReviewPayload` | AI review context | Provider adapters | Contains changed files, rendered diff, optional full-file context, and final prompt. |
| `RawAiReviewOutput` | Provider output parser | AI verdict and transcript | Must match schema version `1` and strict finding fields. |
| `AiFinding` | Review-output normalization | Verdict and transcript | Adds provider/model source metadata and normalized severity/category. |
| `LocalAiVerdict` | Verdict module | AI gate | Contains final exit code plus transcript events. |

## Dependency Shape

The high fan-in files are useful because they hide internal layout:

| File | Why modules depend on it |
|---|---|
| `src/config/index.ts` | Public config barrel for loader, constants, errors, and config types. |
| `src/path-policy/index.ts` | Public changed-file policy barrel for resolver, filters, errors, and types. |
| `src/ai/types.ts` | Shared local AI review types and provider contracts. |
| `src/runner/deterministic.ts` | Main deterministic-check interface and changed-file token helpers. |
| `src/git/command.ts` | Shared Git command execution and checked-error behavior. |

Keep barrels deep. They should expose module interfaces, not every internal
helper.

## Test Coverage Map

| Behavior | Primary tests |
|---|---|
| Config schema, defaults, provider selection, legacy config errors | `test/config.test.ts` |
| Changed-file parsing, ignored paths, target-ref errors, deleted files | `test/path-policy.test.ts` |
| Deterministic policies, plugin checks, tool commands, fail-fast behavior | `test/deterministic-runner.test.ts`, `test/runner.test.ts` |
| Hook protocol, pre-push runner behavior, skip controls, provider stubs | `test/runner.test.ts`, `test/hook.test.ts` |
| Installer behavior and installed hook assets | `test/install.test.ts` |
| Process outcome behavior | `test/process.test.ts` |
| Local AI prompt context, guardrails, provider adapters, output repair, verdicts | `test/ai.test.ts` |

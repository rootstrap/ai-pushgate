# Pushgate Onboarding Guide

This guide is generated from the project's knowledge graph and is intended as a first-pass map for new contributors.

Graph source: `.understand-anything/knowledge-graph.json`
Analyzed at: `2026-06-16T12:39:49.603Z`
Git commit: `13cf3b8ebf6b1aacc4dcaf44fea87a49d21d8206`

## Project Overview

Pushgate is a language-agnostic push gate for regular `git push` workflows. An installed pre-push hook delegates into a managed Pushgate runner so local checks and AI review can fit the normal push flow before changes reach the next layer of review.

Primary languages and formats:

- TypeScript
- JavaScript
- JSON
- YAML
- Shell
- Markdown

Core technologies and tooling:

- Node.js
- TypeScript
- AJV
- tsx
- esbuild
- GitHub Actions

At a high level, Pushgate has three product concerns:

- Install a thin Git hook and a managed runner.
- Evaluate deterministic local checks against the intended push.
- Optionally run provider-backed local AI review and convert the result into a push verdict.

## Architecture Layers

### Project Contract And Release

This layer holds package metadata, repository documentation, release automation, generated distribution entrypoints, and public project contract files.

Key files:

- `README.md` - Main product entry point for the pre-push workflow, install path, config contract, templates, and skip controls.
- `package.json` - Defines build, bundle, shell-check, typecheck, and test scripts plus runtime dependencies.
- `CONTRIBUTING.md` - Explains the contribution workflow and template extension expectations.
- `bin/pushgate.mjs` - Generated distributable runner artifact built from the TypeScript CLI.
- `src/skip-controls.ts` - Reads one-push Git config flags and builds push arguments for skipping all checks or only local AI review.
- `CHANGELOG.md`, `VERSION`, `.release-please-manifest.json`, and `release-please-config.json` - Release state and automation contract.

### CLI And Push Workflow

This layer contains the command-line entrypoints, Git hook integration, argument parsing, user-facing errors, and pre-push orchestration.

Key files:

- `hook/pre-push` - Thin Git hook that validates the managed runner boundary and delegates into Pushgate.
- `src/cli.ts` - Main CLI dispatcher for hook-protocol, pre-push, and wrapper push commands.
- `src/cli/push-args.ts` - Push argument parsing helpers.
- `src/cli/errors.ts` - CLI-oriented error handling.
- `src/workflows/pre-push.ts` - Coordinates repository resolution, changed-file filtering, deterministic gates, local AI review, and final push decisions.

### Configuration And Schema Validation

This layer loads, normalizes, validates, and documents the v2 configuration contract.

Key files:

- `schemas/pushgate-config-v2.schema.json` - Main JSON schema for v2 Pushgate configuration.
- `schemas/ai-review-output-v1.schema.json` - JSON schema for structured AI review output.
- `src/config/index.ts` - Public config facade for loading, validating, and normalizing config.
- `src/config/load.ts` - Config file loading.
- `src/config/normalize.ts` - Runtime normalization of config shape and defaults.
- `src/config/validation.ts` - Schema validation integration.
- `src/config/types.ts` - TypeScript contract for provider settings, tool execution, and built-in policies.
- `src/generated/pushgate-config-v2-validator.ts` and `src/generated/ai-review-output-v1-validator.ts` - Generated AJV validators.
- `templates/*.yml` - Starter configs for base, TypeScript, Node, Rails, Ruby, and Next.js repositories.

### Path Policy And Git State

This layer resolves what changed, determines the target comparison point, parses diffs, and applies path policy before runner phases consume the file list.

Key files:

- `src/path-policy/index.ts` - Public path-policy composition.
- `src/path-policy/git-resolution.ts` - Target branch and Git range resolution.
- `src/path-policy/diff-parsers.ts` - Git diff parsing.
- `src/path-policy/filtering.ts` - Ignore-path filtering.
- `src/path-policy/errors.ts` and `src/path-policy/types.ts` - Path policy error and type contracts.
- `src/git/command.ts`, `src/git/config.ts`, `src/git/push.ts`, and `src/git/repository.ts` - Git command helpers and repository state support.

### Process Execution

This layer centralizes process execution so deterministic tools and provider commands share timeout, output, and stdio behavior.

Key files:

- `src/process/run-command.ts` - Captured command execution helper.
- `src/process/timed-command.ts` - Timeout-aware command execution.
- `src/process/inherited-command.ts` - Command execution with inherited stdio.
- `src/process/output.ts` - Output handling helpers.

### Local AI Review

This layer handles provider registry selection, Claude and Copilot adapters, prompt/context construction, guardrails, transcripts, output normalization, and verdict rendering.

Key files:

- `src/ai/index.ts` - Coordinates provider-backed local AI review, prompt budgeting, provider selection, normalized findings, and blocking versus advisory outcomes.
- `src/ai/provider-registry.ts` - Provider selection registry.
- `src/ai/providers/config.ts` - Provider configuration support.
- `src/ai/providers/claude.ts` - Claude Code CLI adapter.
- `src/ai/providers/copilot.ts` - GitHub Copilot CLI adapter.
- `src/ai/providers/run-provider-command.ts` - Shared execution for provider CLI commands.
- `src/ai/providers/normalize-review.ts` - Provider result normalization.
- `src/ai/review-context.ts` - Builds review context from Git metadata, changed files, diffs, and policy state.
- `src/ai/review-prompt.ts` and `src/ai/prompts/review-prompt.md` - Runtime prompt construction and maintained prompt copy.
- `src/ai/review-output.ts` - Parses provider JSON, handles wrapped or fenced responses, and validates finding categories and severities.
- `src/ai/guardrails.ts`, `src/ai/transcript.ts`, `src/ai/types.ts`, and `src/ai/verdict.ts` - Guardrail, transcript, type, and verdict support.

### Deterministic Runner

This layer evaluates deterministic push gates, configured tool commands, policy summaries, and transcript rendering.

Key files:

- `src/runner/deterministic.ts` - Runs configured checks, expands changed-file arguments, captures tool output, and enforces blocking versus warning behavior.
- `src/runner/policies.ts` - Built-in policies such as diff-size and forbidden-path checks.
- `src/runner/tool-command.ts` - Configured tool command execution.
- `src/runner/summary.ts` - Summary rendering for built-in and configured checks.
- `src/runner/transcript.ts` - Deterministic runner transcript rendering.

### Documentation And Refactor Plans

This layer preserves product decisions, issue plans, and staged refactor plans.

Key files:

- `docs/distribution-runner.md` - Distribution runner behavior and product decisions.
- `docs/v2-config-schema.md` - Detailed v2 config schema design and changed-file review contract.
- `docs/product-contract-plan.md` - Product-level Pushgate contract and repository boundary decisions.
- `docs/issue-*.md` - Issue-oriented implementation plans.
- `docs/refactor-*.md` - Staged module-boundary and architecture plans.

### CI Distribution And Automation

This layer contains GitHub Actions workflows, build scripts, installer support, and distribution automation.

Key files:

- `install.sh` - Downloads the managed runner, installs the pre-push hook, and seeds a template `.pushgate.yml`.
- `scripts/build-runner.mjs` - Bundles `src/cli.ts` into `bin/pushgate.mjs`.
- `scripts/build-validators.mjs` - Builds generated schema validators.
- `scripts/md-loader.mjs` and `scripts/register-md-loader.mjs` - Markdown import support for runtime prompt loading.
- `.github/workflows/ci.yml` - Main validation pipeline.
- `.github/workflows/release-please.yml` - Automated release PR, version, and changelog workflow.

### Test Suite

This layer verifies behavior through Node tests, harnesses, fixtures, and support files.

Key files:

- `test/ai.test.ts` - Prompt rendering, provider normalization, and review-output parsing.
- `test/config.test.ts` - Valid configs, schema validation failures, and legacy migration behavior.
- `test/deterministic-runner.test.ts` - Tool execution, fail-fast behavior, and built-in policy enforcement.
- `test/hook.test.ts` - Thin pre-push hook boundary behavior.
- `test/install.test.ts` - Installer, command download, hook installation, and config seeding behavior.
- `test/path-policy.test.ts` - Git diff parsing and ignore-path filtering.
- `test/runner.test.ts` - Integration-style CLI workflow coverage across config, deterministic checks, and local AI gating.
- `test/support/hook-harness.ts` - Isolated Git repo and managed-runner stub harness for hook boundary tests.
- `test/fixtures/config/*.yml` - Config parser fixture scenarios.

## Key Concepts

- Pushgate is intentionally part of the normal Git workflow. The installed pre-push hook should stay thin, and most logic belongs in the managed runner.
- The push decision is layered. Changed-file policy feeds deterministic checks first, and local AI review runs after deterministic gates have enough context.
- Configuration v2 is a core product contract. Treat `schemas/pushgate-config-v2.schema.json`, `src/config/types.ts`, and the generated validator as a coordinated set.
- Provider adapters hide CLI-specific behavior. Claude and Copilot can fail differently, but the rest of Pushgate should consume normalized provider results.
- AI review output is schema-backed. `src/ai/review-output.ts` is responsible for accepting real-world model output while still enforcing categories, severities, and shape.
- Process execution is shared infrastructure. External tool commands and provider commands should use the process helpers instead of creating new command-running paths.
- Generated artifacts are part of distribution, not the first place to edit. Prefer source files, schemas, and build scripts over modifying generated validators or `bin/pushgate.mjs` by hand.
- Tests double as executable architecture notes. The most useful first test reads are `test/runner.test.ts`, `test/config.test.ts`, `test/path-policy.test.ts`, and `test/ai.test.ts`.

## Guided Tour

1. Project Contract
   - Start with `README.md`, `package.json`, and `CONTRIBUTING.md` to understand Pushgate as a Git pre-push gate with deterministic checks and provider-backed local AI review.

2. CLI And Hook Entry
   - Follow `hook/pre-push` into `src/cli.ts`, `src/cli/push-args.ts`, `src/cli/errors.ts`, and `src/workflows/pre-push.ts`.

3. Configuration Loading
   - Read `src/config/index.ts`, `src/config/load.ts`, `src/config/normalize.ts`, `src/config/validation.ts`, `src/config/errors.ts`, and `src/generated/pushgate-config-v2-validator.ts`.

4. Changed File Policy
   - Trace `src/path-policy/index.ts`, `src/path-policy/diff-parsers.ts`, `src/path-policy/filtering.ts`, `src/path-policy/git-resolution.ts`, `src/git/command.ts`, and `src/git/repository.ts`.

5. Deterministic Gate
   - Inspect `src/runner/deterministic.ts`, `src/runner/policies.ts`, `src/runner/tool-command.ts`, `src/runner/summary.ts`, and `src/runner/transcript.ts`.

6. Process Execution Boundary
   - Review `src/process/run-command.ts`, `src/process/timed-command.ts`, `src/process/inherited-command.ts`, and `src/process/output.ts`.

7. Provider Commands
   - Follow provider selection and command execution through `src/ai/provider-registry.ts`, `src/ai/providers/config.ts`, `src/ai/providers/claude.ts`, `src/ai/providers/copilot.ts`, `src/ai/providers/run-provider-command.ts`, and `src/ai/providers/normalize-review.ts`.

8. Review Context And Verdict
   - Study `src/ai/review-context.ts`, `src/ai/review-prompt.ts`, `src/ai/guardrails.ts`, `src/ai/review-output.ts`, `src/ai/transcript.ts`, and `src/ai/verdict.ts`.

9. Distribution And Templates
   - Connect `scripts/build-runner.mjs`, `scripts/build-validators.mjs`, `bin/pushgate.mjs`, `templates/base.yml`, `templates/typescript.yml`, and `docs/distribution-runner.md`.

10. Tests And Refactor Plans
    - Use `test/ai.test.ts`, `test/config.test.ts`, `test/deterministic-runner.test.ts`, `test/path-policy.test.ts`, `docs/refactor-06-distribution-module-plan.md`, and `docs/refactor-11-review-context-split-plan.md` to understand verification and next architecture steps.

## File Map

### Entry And Product Contract

- `README.md` - Product overview, install flow, config contract, templates, and skip controls.
- `CONTRIBUTING.md` - Contribution workflow and repository development expectations.
- `package.json` - Scripts, dependencies, package entrypoints, and project automation.
- `src/cli.ts` - CLI dispatcher.
- `hook/pre-push` - Installed Git hook entry.
- `src/workflows/pre-push.ts` - Top-level pre-push workflow coordinator.
- `src/skip-controls.ts` - One-push skip flag support.

### Config And Templates

- `schemas/pushgate-config-v2.schema.json` - Main config schema.
- `schemas/ai-review-output-v1.schema.json` - Structured review output schema.
- `src/config/index.ts` - Config loading facade.
- `src/config/load.ts` - Config file loading.
- `src/config/normalize.ts` - Config defaults and normalization.
- `src/config/validation.ts` - Schema validation.
- `src/config/types.ts` - Config TypeScript types.
- `src/config/errors.ts` - Config error types and messages.
- `templates/base.yml` - Base starter template.
- `templates/typescript.yml`, `templates/node.yml`, `templates/nextjs.yml`, `templates/ruby.yml`, and `templates/rails.yml` - Stack-specific starter templates.

### Git And Path Policy

- `src/git/command.ts` - Git command helper.
- `src/git/config.ts` - Git configuration helper.
- `src/git/push.ts` - Push-related helper.
- `src/git/repository.ts` - Repository resolution helper.
- `src/path-policy/index.ts` - Changed-file policy composition.
- `src/path-policy/diff-parsers.ts` - Diff parsing.
- `src/path-policy/filtering.ts` - Ignore-path filtering.
- `src/path-policy/git-resolution.ts` - Target branch and diff range resolution.
- `src/path-policy/errors.ts` and `src/path-policy/types.ts` - Path policy contracts.

### Deterministic Checks And Processes

- `src/runner/deterministic.ts` - Deterministic check orchestration.
- `src/runner/policies.ts` - Built-in policy checks.
- `src/runner/tool-command.ts` - Configured tool command execution.
- `src/runner/summary.ts` - Check summary formatting.
- `src/runner/transcript.ts` - Deterministic transcript formatting.
- `src/process/run-command.ts` - Captured command execution.
- `src/process/timed-command.ts` - Timed command execution.
- `src/process/inherited-command.ts` - Inherited-stdio command execution.
- `src/process/output.ts` - Process output support.

### Local AI Review

- `src/ai/index.ts` - Main local AI review orchestration.
- `src/ai/provider-registry.ts` - Provider registry.
- `src/ai/providers/claude.ts` - Claude provider adapter.
- `src/ai/providers/copilot.ts` - Copilot provider adapter.
- `src/ai/providers/config.ts` - Provider config.
- `src/ai/providers/run-provider-command.ts` - Provider CLI command execution.
- `src/ai/providers/normalize-review.ts` - Provider result normalization.
- `src/ai/review-context.ts` - Review context construction.
- `src/ai/review-prompt.ts` - Runtime prompt payload construction.
- `src/ai/prompts/review-prompt.md` - Maintained prompt text.
- `src/ai/review-output.ts` - Structured output parsing and validation.
- `src/ai/guardrails.ts` - Review guardrails.
- `src/ai/transcript.ts` - AI review transcript support.
- `src/ai/types.ts` - Shared AI review types.
- `src/ai/verdict.ts` - Push verdict logic.

### Generated And Distribution

- `src/generated/pushgate-config-v2-validator.ts` - Generated config validator.
- `src/generated/ai-review-output-v1-validator.ts` - Generated review-output validator.
- `src/generated/README.md` - Maintainer notes for generated files.
- `bin/pushgate.mjs` - Generated distributable runner.
- `install.sh` - Installer script.
- `scripts/build-runner.mjs` - Runner bundling script.
- `scripts/build-validators.mjs` - Validator generation script.
- `scripts/md-loader.mjs` and `scripts/register-md-loader.mjs` - Markdown loader scripts.

### CI And Release

- `.github/workflows/ci.yml` - CI validation workflow.
- `.github/workflows/release-please.yml` - Release automation workflow.
- `.github/PULL_REQUEST_TEMPLATE.md` - PR checklist and contribution context.
- `CHANGELOG.md` - Release history.
- `VERSION` - Current package version marker.
- `.release-please-manifest.json` and `release-please-config.json` - Release Please configuration.

### Tests

- `test/ai.test.ts` - AI review behavior.
- `test/config.test.ts` - Config behavior.
- `test/deterministic-runner.test.ts` - Deterministic runner behavior.
- `test/hook.test.ts` - Hook boundary behavior.
- `test/install.test.ts` - Installer behavior.
- `test/path-policy.test.ts` - Changed-file policy behavior.
- `test/runner.test.ts` - Integration-style runner behavior.
- `test/support/hook-harness.ts` - Isolated Git repo test harness.
- `test/fixtures/config/*.yml` - Config fixture scenarios.

## Complexity Hotspots

Approach these files carefully first, especially when changing public behavior:

- `src/ai/index.ts` - Coordinates prompt budgeting, provider selection, normalized findings, and blocking versus advisory outcomes.
- `src/ai/review-output.ts` - Accepts messy provider output while enforcing structured review schema expectations.
- `schemas/pushgate-config-v2.schema.json` - Defines the main user-facing configuration contract.
- `src/generated/pushgate-config-v2-validator.ts` and `src/generated/ai-review-output-v1-validator.ts` - Generated validators. Change schemas or generation scripts rather than hand-editing them.
- `bin/pushgate.mjs` - Generated distribution artifact. Verify source and build behavior before treating it as authoritative.
- `test/support/hook-harness.ts` - Builds isolated Git repo scenarios and runner stubs, so small changes can affect many hook tests.
- `test/runner.test.ts` - Exercises the integrated CLI flow across config, deterministic checks, and local AI gating.
- `test/config.test.ts` - Protects config validation and migration behavior.
- `test/path-policy.test.ts` - Protects diff parsing and ignore-path behavior.
- `test/ai.test.ts` - Protects prompt rendering, provider normalization, and structured output parsing.
- `docs/issue-19-github-copilot-provider-adapter-plan.md` - Design reference for Copilot provider adapter behavior.

## Suggested First Contribution Path

1. Read `README.md`, then install dependencies and run the standard validation commands from `package.json`.
2. Trace the happy path from `hook/pre-push` to `src/cli.ts` to `src/workflows/pre-push.ts`.
3. Pick one behavior area and read its test first.
4. Make source changes in the layer that owns the behavior.
5. Regenerate distribution or validators only when changing the CLI bundle, schemas, or prompt-loading behavior.
6. Run targeted tests first, then the full project validation before opening a PR.


# ai-pushgate

`ai-pushgate` is the v2 direction for a local pre-push gate plus CI/PR
enforcement workflow.

The product contract in this README defines what v2 will guarantee before the
runtime rewrite starts. The current repository still contains the inherited v1
`push-review` shell hook and templates; those runtime pieces will be migrated in
later roadmap issues.

## v2 Product Contract

`ai-pushgate` separates fast local feedback from authoritative enforcement:

| Surface | Purpose | Blocking authority |
|---|---|---|
| Local pre-push | Fast deterministic checks before code leaves a developer machine | Convenience only; always bypassable |
| Local AI | Optional review feedback near the developer workflow | Advisory by default |
| CI/PR | Repeatable checks, review summaries, and policy enforcement | Source of truth for teams |

Local hooks help developers catch issues early, but they are not a security or
compliance boundary. Anything that must be enforced for a team belongs in CI/PR
checks combined with repository branch protection.

## v2 Defaults

- Config file: `.pushgate.yml`.
- v2 does not read `.push-review.yml`; v1 users must migrate.
- Deterministic local checks are the default local gate.
- Local AI defaults to `advisory` when configured and available.
- Local AI can block only through explicit advanced configuration.
- Provider failures do not block in advisory mode.
- AI payloads default to diff-only context.
- Full-file AI context is opt-in.
- Secret redaction is expected before any source content is sent to an AI
  provider.

## Proposed v2 Config Shape

This is the public contract shape for the v2 schema. Exact validation and
runtime parsing are tracked separately in the roadmap.

```yaml
version: 2

project:
  base_ref: main
  include_paths:
    - "**/*"
  exclude_paths:
    - "*.lock"
    - "dist/**"
    - "coverage/**"

local:
  fail_fast: true
  budget_seconds: 60

checks:
  - name: eslint
    command: ["npx", "eslint", "{changed_files}"]
    mode: blocking
    run: changed_files
    extensions: [".js", ".jsx", ".ts", ".tsx"]
    timeout_seconds: 30

  - name: tests
    command: ["npm", "test"]
    mode: warning
    run: always
    timeout_seconds: 60

ai:
  mode: advisory # off | advisory | blocking
  provider:
    name: claude
  privacy:
    send_diff: true
    send_full_files: false
    redact_secrets: true

ci:
  mirror_blocking_checks: true
```

### Config Fields

`project.base_ref` defines the comparison base used to collect changed files.
`project.include_paths` and `project.exclude_paths` define the shared path
policy for deterministic checks and optional AI.

`checks[]` defines deterministic commands. Commands are argv arrays, not shell
strings, so changed files can be passed safely as discrete arguments. A check can
run on changed files or the whole project, and can be `blocking` or `warning`.

`ai.mode` controls local AI behavior:

| Mode | Behavior |
|---|---|
| `off` | Do not run local AI |
| `advisory` | Run local AI when available, print findings, never block |
| `blocking` | Allow local AI findings to block only when explicitly configured |

`ci` is reserved for generated or documented CI mirror behavior. CI/PR policy is
where teams should enforce required checks.

## Git Workflow Integration

The default developer workflow should remain regular Git:

```bash
git push
```

In v2, the installed `.git/hooks/pre-push` hook should be a thin delegator that
invokes the versioned runner:

```bash
pushgate pre-push
```

The hook is responsible for passing along Git hook input and exiting with the
runner's exit code. The runner owns config loading, changed-file detection,
deterministic checks, optional local AI, and user-facing output.

The `pushgate push` wrapper is an ergonomic layer for flags Git cannot pass to
hooks, not a replacement for the normal Git workflow. It should translate
pushgate-specific flags into temporary Git config and then call `git push`.

## Skip Controls

Raw `git push` cannot pass arbitrary `--skip-*` flags to a pre-push hook; Git
rejects unknown `git push` flags before the hook runs. For a one-off skip in the
regular Git workflow, pass temporary pushgate config with Git:

```bash
git -c pushgate.skip-ai-check=true push
git -c pushgate.skip-all-checks=true push
```

`pushgate.skip-ai-check` skips only local AI while preserving deterministic
checks. `pushgate.skip-all-checks` skips all local pushgate behavior for that
push.

The `pushgate push` wrapper provides shorter equivalents:

```bash
pushgate push --skip-ai-check
pushgate push --skip-all-checks
```

The wrapper should apply the matching temporary Git config before it calls
`git push`.

Git also keeps its native escape hatch:

```bash
git push --no-verify
```

`--no-verify` skips Git hooks entirely, including pushgate.

## Privacy Contract

The default AI payload is changed-file metadata and diff context only. Full-file
context must be enabled explicitly because it can increase latency, cost, and
privacy exposure.

Before any AI call, pushgate should apply the configured path policy and secret
redaction. If redaction cannot run, local AI should fail closed for privacy by
skipping AI feedback instead of sending unredacted content.

## v1 Migration

v2 is a hard break from the inherited v1 `push-review` contract.

| v1 | v2 |
|---|---|
| `.push-review.yml` | `.pushgate.yml` |
| `review.target_branch` | `project.base_ref` |
| `ignore_paths` | `project.exclude_paths` |
| shell-string tool commands | argv-array `checks[].command` |
| AI review can block local pushes by default | local AI defaults to advisory |
| Claude-specific local review path | provider abstraction tracked for v2 AI work |

The migration layer should produce clear errors when only `.push-review.yml` is
present, point users to `.pushgate.yml`, and avoid silently interpreting a v1
file as v2 config.

## Roadmap Boundaries

This README documents the v2 contract for
[issue #1](https://github.com/rootstrap/ai-pushgate/issues/1). Implementation is
split across later issues:

- Schema validation and config loading: issue #2.
- Hook and runner test harness: issue #3.
- Thin Git hook plus `pushgate` runner: issue #4.
- Changed-file policy, deterministic commands, and built-in checks: issues #5-#7.
- CI mirror generation and parity reporting: issues #8-#9.
- AI providers, local AI guardrails, structured output, and PR surfaces: issues
  #10-#14.

## Current Runtime Status

The checked-in runtime is still the v1 `push-review` shell implementation. It
uses `.push-review.yml`, includes Claude-specific behavior, and predates the v2
contract above. That code remains in place until the roadmap issues replace it.

When contributing to issue #1, avoid changing runtime files such as
`hook/pre-push`, `install.sh`, or `templates/*.yml`; this issue is intentionally
limited to the public contract.

## Contributing

All changes should go through a pull request. Release files are managed by
release-please and should not be edited manually.

For this documentation milestone, verify that runtime scripts still parse and
that template YAML remains valid:

```bash
bash -n hook/pre-push
bash -n install.sh
for f in templates/*.yml; do python3 -c "import yaml; yaml.safe_load(open('$f'))"; done
```

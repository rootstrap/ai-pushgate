# Configuration Reference

Pushgate v2 reads `.pushgate.yml`. The formal schema artifact is
`schemas/pushgate-config-v2.schema.json`; the config loader validates that
schema before returning normalized config to later runner and AI modules.

## Shape

```yaml
version: 2

review:
  target_branch: main
  context_lines: 10
  max_lines_for_full_file: 300

tools:
  - name: eslint
    command: ["npx", "eslint", "{changed_files}"]
    extensions: [".js", ".jsx", ".ts", ".tsx"]
    timeout_seconds: 60
    mode: blocking
    run: changed_files
    fail_fast: true

policies:
  diff_size:
    max_changed_lines: 500
    mode: warning
    fail_fast: false
  forbidden_paths:
    patterns:
      - ".env"
      - "secrets/**"
    mode: blocking
    fail_fast: true

plugins:
  gitleaks:
    enabled: true
    command: gitleaks
    timeout_seconds: 60
    mode: blocking
    fail_fast: true
    config_path: .gitleaks.toml
    baseline_path: .gitleaks/baseline.json
    gitleaks_ignore_path: .gitleaksignore

ai:
  mode: blocking
  verbose: true
  max_changed_lines: 500
  max_prompt_tokens: 12000
  timeout_seconds: 120
  provider: claude
  providers:
    claude:
      model: claude-sonnet-4-20250514
      # Optional API-key/script mode. Defaults to false.
      # bare: true
    copilot:
      model: auto

ignore_paths:
  - "*.lock"
  - "dist/**"
```

Core sections are strict. Unknown top-level, `review`, `tools`, `policies`,
`plugins`, or `ai` keys are validation errors. `ai.providers.<provider>` is the
extension point for provider-specific nested settings.

## Defaults

| Field | Default |
|---|---|
| `review.target_branch` | `main` |
| `review.context_lines` | `10` |
| `review.max_lines_for_full_file` | `300` |
| `tools` | `[]` |
| `policies` | `{}` |
| `plugins` | `{}` |
| `ignore_paths` | `[]` |
| `ai.mode` | `blocking` |
| `ai.verbose` | `true` |
| `tools[].timeout_seconds` | `60` |
| `tools[].mode` | `blocking` |
| `tools[].run` | `changed_files` |
| `tools[].fail_fast` | `true` |
| `policies.diff_size.mode` | `blocking` |
| `policies.diff_size.fail_fast` | `true` |
| `policies.forbidden_paths.mode` | `blocking` |
| `policies.forbidden_paths.fail_fast` | `true` |
| `plugins.gitleaks.enabled` | `true` |
| `plugins.gitleaks.command` | `gitleaks` |
| `plugins.gitleaks.timeout_seconds` | `60` |
| `plugins.gitleaks.mode` | `blocking` |
| `plugins.gitleaks.fail_fast` | `true` |
| `plugins.gitleaks.redact` | `true` |
| `ai.max_changed_lines` | `500` |
| `ai.max_prompt_tokens` | `12000` |
| `ai.timeout_seconds` | `120` |

`blocking` and `advisory` AI modes must set `ai.provider` and define a matching
`ai.providers.<provider>` block. `ai.mode: off` may omit provider config.

## Review Settings

| Field | Meaning |
|---|---|
| `target_branch` | Local or remote-tracking branch/ref used as the changed-file target. |
| `context_lines` | Surrounding diff lines included when local AI review context is prepared. |
| `max_lines_for_full_file` | Diff-size cutoff below which local AI may include full file context. |

## Tool Commands

Tool commands are argv arrays, not shell strings. `{changed_files}` may be one
array token for the deterministic runner to expand into individual argv entries
without shell interpolation.

| Field | Meaning |
|---|---|
| `name` | Human-readable command label used in local output. |
| `command` | Argv tokens; `{changed_files}` remains a runner expansion token. |
| `extensions` | Optional suffix filters for live changed-file execution. |
| `timeout_seconds` | Maximum command runtime before Pushgate treats the tool as timed out. |
| `mode` | `blocking` stops the push; `warning` requires confirmation. |
| `run` | `changed_files` skips when no live matching paths exist; `always` runs regardless. |
| `fail_fast` | Whether a blocking failure stops later deterministic checks. |

## Built-In Policies

Built-in policies are optional deterministic checks that do not require external
commands. They run before plugins and configured tools.

| Policy | Meaning |
|---|---|
| `diff_size` | Counts added plus deleted text lines in the normalized changed-file list. Binary diffs do not contribute. |
| `forbidden_paths` | Matches gitignore-like patterns against live changed paths after `ignore_paths` filtering. Deleted files are ignored. |

Policy `mode` and `fail_fast` use the same blocking, warning, and fail-fast
behavior as configured tools.

## Plugins

Plugins are first-class adapters for external tools whose behavior is richer
than a plain argv command. They run after built-in policies and before generic
tools.

`plugins.gitleaks` delegates secret scanning to the Gitleaks CLI. It runs
`gitleaks git` against the scan range from changed-file resolution
(`<merge-base>..HEAD`) and writes findings to a temporary JSON report. That
catches secrets introduced anywhere in the commits being pushed, including
secrets added in one commit and removed in a later commit before the final diff.

Pushgate owns invocation, timeout, redaction default, and local result
rendering. Rule tuning, baselines, ignored fingerprints, and allowlists remain
Gitleaks concerns.

## Legacy Config

The v2 loader does not parse `.push-review.yml` as `.pushgate.yml`. A repository
with only the legacy file fails with migration guidance. If both files exist,
the loader returns `.pushgate.yml` and warns that the legacy file is ignored.

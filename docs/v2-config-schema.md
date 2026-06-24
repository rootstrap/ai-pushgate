# Pushgate V2 Config Schema

Pushgate v2 reads `.pushgate.yml`. The formal schema artifact is
`schemas/pushgate-config-v2.schema.json`; the Node config loader validates that
schema before returning normalized config to later runner and AI layers.

## Shape

Every v2 config declares its version:

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
  forbidden_paths:
    patterns:
      - ".env"
      - "secrets/**"
    mode: blocking

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

The core surface is strict. Unknown top-level, `review`, `tools`, `policies`,
`plugins`, or `ai` keys are validation errors. `ai.providers.<provider>` is the
extension point for provider-specific nested settings that later adapters
consume.

## Defaults

The loader normalizes omitted optional values into one internal shape:

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
| `tools[].timeout_seconds` | `60` |
| `tools[].mode` | `blocking` |
| `tools[].run` | `changed_files` |
| `tools[].fail_fast` | `true` |
| `policies.diff_size.mode` | `blocking` |
| `policies.forbidden_paths.mode` | `blocking` |
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

The built-in provider IDs are `claude` and `copilot`. `claude` invokes Claude
Code CLI. `copilot` invokes the standalone GitHub Copilot CLI through its
programmatic prompt path, using the shared Pushgate prompt and normalized JSON
review-output contract. `ai.providers.<provider>.model` is optional for both
providers; when omitted, the provider CLI chooses its default model.
`ai.providers.claude.bare` is optional and defaults to `false`; Pushgate uses
Claude Code safe mode by default so local OAuth login still works while local
Claude customizations stay disabled. Set `bare: true` only for API-key or
settings-helper automation, because Claude Code bare mode skips OAuth/keychain
reads.

## Local AI Modes And Guardrails

Local AI supports three modes:

```yaml
ai:
  mode: blocking   # blocking | advisory | off
  max_changed_lines: 500
  max_prompt_tokens: 12000
  timeout_seconds: 120
```

`blocking` is the default. Blocking findings and provider failures stop the
push. `advisory` renders the same findings and provider failures but allows the
push to continue. `off` skips the local AI phase and does not require provider
selection.

`ai.max_changed_lines` counts added plus deleted text lines in the normalized
changed-file list after `ignore_paths` filtering. Binary diffs do not
contribute to this count. If the count exceeds the configured value, Pushgate
blocks the push before invoking the configured provider. This keeps oversized
diffs from bypassing local AI review silently.

`ai.max_prompt_tokens` is an approximate provider-neutral budget over the
rendered prompt. Provider tokenizers differ, so Pushgate intentionally uses a
local estimate instead of coupling the core schema to a provider-specific
tokenizer. If the estimate exceeds the configured value, Pushgate prints a
visible local-AI skip message and continues.

`ai.timeout_seconds` is passed to the selected provider adapter. A timeout is a
provider failure: it blocks in `blocking` mode and warns in `advisory` mode.

If local AI completes with warning findings, or with advisory-mode provider
failures, Pushgate asks whether to continue before allowing the push. Declining
the prompt blocks the push. If Pushgate cannot open an interactive terminal for
the prompt, it fails closed and blocks the push.

## Tool Commands

Tool commands are argv arrays, not shell strings. `{changed_files}` may be one
array token for the deterministic command runner to expand into individual argv
entries without shell interpolation:

```yaml
tools:
  - name: prettier
    command: ["npx", "prettier", "--check", "{changed_files}"]
```

Each tool may also define execution behavior:

```yaml
tools:
  - name: eslint
    command: ["npx", "eslint", "{changed_files}"]
    extensions: [".js", ".jsx", ".ts", ".tsx"]
    timeout_seconds: 60
    mode: blocking      # blocking | warning
    run: changed_files  # changed_files | always
    fail_fast: true
```

`run: changed_files` skips the tool when no non-deleted changed files match its
optional `extensions` filter. `run: always` runs the command regardless of the
scoped file list; if the command includes `{changed_files}`, that token expands
to zero or more argv entries. Warning-mode failures are reported, then Pushgate
asks whether to continue before allowing the push. Blocking failures stop later
tools when `fail_fast` is true.

## Built-In Policies

Built-in policies are optional deterministic checks that do not require external
commands. They run before configured tool commands and share the same local
`blocking` or `warning` behavior in terminal output and exit-code summaries.
Warning-mode policy failures require the same continue-with-warnings
confirmation as warning-mode tool failures.

```yaml
policies:
  diff_size:
    max_changed_lines: 500
    mode: warning

  forbidden_paths:
    patterns:
      - ".env"
      - ".env.*"
      - "secrets/**"
      - "*.pem"
    mode: blocking
```

`diff_size.max_changed_lines` counts added plus deleted text lines in the
normalized changed-file list. Binary diffs do not contribute text-line counts.

`forbidden_paths.patterns` uses gitignore-like rules against live changed paths
after `ignore_paths` filtering. Deleted files are ignored by this policy so
removing a forbidden file is not blocked. Matching added, modified, copied, or
renamed target paths are reported with the matched pattern and either block or
warn according to `mode`.

## Plugins

Plugins are first-class adapters for external tools whose behavior is richer
than a plain argv command. They run after built-in policies and before generic
`tools` entries, and they share the same `blocking` or `warning` result model.

### Gitleaks

`plugins.gitleaks` delegates secret scanning to the Gitleaks CLI:

```yaml
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
    redact: true
    max_decode_depth: 2
    max_archive_depth: 1
    max_target_megabytes: 10
    enable_rules:
      - generic-api-key
```

The adapter runs `gitleaks git` against the scan range returned by changed-file
resolution (`<merge-base>..HEAD`) and writes findings to a temporary JSON
report. That makes the push gate catch secrets introduced anywhere in the
commits being pushed, including secrets added in one commit and removed in a
later commit before the final diff.

Pushgate owns only the invocation, timeout, redaction default, and local result
rendering. Rule tuning, baselines, ignored fingerprints, and custom allowlists
remain Gitleaks concerns through `.gitleaks.toml`, `.gitleaksignore`, and
baseline reports.

## Changed-File Policy

The changed-file path policy resolves `review.target_branch` locally and uses
the documented `<target_branch>...HEAD` Git diff range to produce the shared
changed-file list. It also returns two named Git ranges: the review range
`<target-commit>...HEAD` for human-readable local AI diff context, and the scan
range `<merge-base>..HEAD` for deterministic scanners that inspect commits. If
the target ref is missing or Git cannot find a merge base with `HEAD`, Pushgate
fails with an explicit diagnostic instead of fetching, guessing a remote
variant, or switching to a different history range.

`ignore_paths` uses gitignore-like rules against Git's repo-relative paths.
Patterns such as `*.lock` match basenames across the changed tree, while
directory rules such as `dist/**` remove that generated subtree before
deterministic tools or AI consume the shared changed-file list. Tool
`extensions` are suffix filters over the remaining current paths; deleted files
remain in normalized changed-file metadata but are not live argv paths for
later changed-file tool commands.

The initial path-policy implementation targets macOS and Linux behavior.
Windows and Git Bash path support remain explicit follow-up scope.

## Review Prompt

Legacy `.push-review.yml` stored reviewer `focus`, `blocking_categories`, and
`warning_categories` lists beside diff settings. The v2 core config does not
mix those AI instructions into `review`; the built-in defaults live with
`src/ai/prompts/review-prompt.md` instead.

The built-in prompt instructs providers to return one JSON object using
Pushgate's normalized review-output contract. Findings carry strict category,
severity, confidence, file, line, message, and suggestion fields; Pushgate
attaches provider source metadata during normalization before rendering the
result in the terminal.

The canonical review-output contract lives in `src/ai/review-contract.ts` as a
Zod schema. `schemas/ai-review-output-v1.schema.json` is generated from that
contract for documentation, external integrations, and future native structured
provider requests. Pushgate validates every provider response locally before it
consumes findings.

Provider enforcement strength follows this ladder: native JSON Schema when a
provider supports constrained schema output, strict tool calls when that is the
strongest available mechanism, JSON mode when it only guarantees JSON syntax,
and text fallback when the provider exposes only a text channel. Text-only
engines cannot provide generation-time schema guarantees, so Pushgate keeps the
prompt exact, applies narrowly scoped safe repair, and rejects anything that
does not validate against the local contract.

The blocking and warning category vocabulary must stay aligned with that
structured AI findings layer. If Pushgate supports project-specific prompt or
category overrides later, that contract should be explicit in the AI schema
rather than hidden in provider-specific config.

## Legacy Files

The v2 loader does not parse `.push-review.yml` as `.pushgate.yml`. A repository
with only the legacy file fails with migration guidance. If both files exist,
the loader returns the `.pushgate.yml` config and a warning that the legacy file
is ignored.

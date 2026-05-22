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

ai:
  mode: blocking
  provider: claude
  providers:
    claude:
      model: claude-sonnet-4-20250514

ignore_paths:
  - "*.lock"
  - "dist/**"
```

The core surface is strict. Unknown top-level, `review`, `tools`, or `ai` keys
are validation errors. `ai.providers.<provider>` is the extension point for
provider-specific nested settings that later adapters consume.

## Defaults

The loader normalizes omitted optional values into one internal shape:

| Field | Default |
|---|---|
| `review.target_branch` | `main` |
| `review.context_lines` | `10` |
| `review.max_lines_for_full_file` | `300` |
| `tools` | `[]` |
| `ignore_paths` | `[]` |
| `ai.mode` | `blocking` |

`blocking` and `advisory` AI modes must set `ai.provider` and define a matching
`ai.providers.<provider>` block. `ai.mode: off` may omit provider config.

## Tool Commands

Tool commands are argv arrays, not shell strings. `{changed_files}` may be one
array token for the later deterministic command runner to expand without shell
interpolation:

```yaml
tools:
  - name: prettier
    command: ["npx", "prettier", "--check", "{changed_files}"]
```

## Changed-File Policy

The changed-file path policy resolves `review.target_branch` locally and uses
the documented `<target_branch>...HEAD` Git diff range. If that ref is missing
or Git cannot find a merge base with `HEAD`, Pushgate fails with an explicit
diagnostic instead of fetching, guessing a remote variant, or switching to a
different history range.

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

The blocking and warning category vocabulary must stay aligned with the later
structured AI findings layer. If Pushgate supports project-specific prompt or
category overrides later, that contract should be explicit in the AI schema
rather than hidden in provider-specific config.

## Legacy Files

The v2 loader does not parse `.push-review.yml` as `.pushgate.yml`. A repository
with only the legacy file fails with migration guidance. If both files exist,
the loader returns the `.pushgate.yml` config and a warning that the legacy file
is ignored.

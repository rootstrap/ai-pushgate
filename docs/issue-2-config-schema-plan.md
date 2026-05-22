# Issue 2 V2 Config Schema Plan

This document records the decisions and implementation scope for issue #2:
freeze the v2 `.pushgate.yml` schema and replace ad hoc YAML parsing with a
reliable parser and validator.

The broader product contract remains in `docs/product-contract-plan.md`. This
plan narrows that contract to the config work that must land before the runner,
deterministic command execution, and AI provider adapters build on it.

## Locked Decisions

| Area | Decision |
|---|---|
| Parser runtime | Implement the v2 config layer in Node. |
| Config versioning | Require an explicit `version: 2` field in `.pushgate.yml`. |
| Schema artifacts | Check in a formal schema artifact and enforce it through runtime validation code. |
| Deterministic command syntax | Keep the `tools` section and require argv-array commands. |
| AI provider config | Use a selected provider plus provider-specific config blocks. |
| Old config behavior | Do not parse `.push-review.yml` as v2 config. |
| Both config files exist | Prefer `.pushgate.yml` and warn about the old `.push-review.yml` file. |
| Hook integration | Leave hook and runner integration for the runner work after this config layer exists. |

## Issue Scope

Issue #2 owns the config contract and config loader boundary:

1. Define and document the versioned v2 `.pushgate.yml` schema.
2. Add a Node YAML parser and schema validator.
3. Normalize valid config into typed internal config for later runner and AI
   code.
4. Return clear validation errors for invalid v2 config.
5. Detect legacy `.push-review.yml` use and provide migration guidance.
6. Add config-focused tests and fixtures.

Issue #2 does not own later behavior that already has backlog coverage:

| Later behavior | Backlog owner |
|---|---|
| Whole hook and runner test harness | Issue #3 |
| Thin installed hook and `pushgate` runner | Issue #4 |
| Changed-file and path policy execution | Issue #5 |
| Deterministic command execution, timeouts, and modes | Issue #6 |
| Local skip controls | Issue #18 |
| AI provider interface and Claude adapter | Issue #10 |
| AI mode guardrail behavior | Issue #11 |
| Structured AI findings | Issue #12 |
| GitHub Copilot adapter | Issue #19 |

The schema must reserve the config shape those tasks need, but this issue should
not implement those behaviors.

## V2 Config Baseline

The schema should make this kind of config valid:

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
    copilot:
      model: gpt-5

ignore_paths:
  - "*.lock"
  - "dist/**"
  - "coverage/**"
```

Core config sections are strict. Provider blocks are the explicit extension
boundary for provider-specific config that later adapters can consume.

## Defaults To Normalize

The v2 config layer should normalize defaults in one place before later
Pushgate layers consume config:

| Config field | Default |
|---|---|
| `review.target_branch` | `main` |
| `review.context_lines` | `10` |
| `review.max_lines_for_full_file` | `300` |
| `tools` | empty list |
| `ignore_paths` | empty list |
| `ai.mode` | `blocking` |

Provider selection should stay explicit for active local AI. A config that uses
`blocking` or `advisory` mode must identify its provider and include the
matching provider block instead of falling through to an implicit vendor.

## Validation Contract

The v2 loader must validate the config before later Pushgate code consumes it.

### Core Schema Rules

- `.pushgate.yml` must declare supported config version `2`.
- Unknown keys in the core v2 config surface are errors.
- Enum values are validated, including `ai.mode`.
- Required fields are validated before defaults are normalized.
- Optional fields are normalized into a typed config shape for consumers.
- YAML comments, nested objects, and multiline list syntax must parse
  consistently.

### Tool Rules

- `tools` remains the deterministic command section name.
- Each tool command is an argv array, not a shell command string.
- A command array must contain non-empty string arguments.
- A plain shell string command is invalid v2 config.
- `{changed_files}` may appear as a command-array token for the later
  deterministic command runner to expand safely.
- Unsafe or ambiguous command shapes fail validation with actionable errors.

For example, this is valid v2 command shape:

```yaml
tools:
  - name: prettier
    command: ["npx", "prettier", "--check", "{changed_files}"]
```

This old shell-string shape is invalid in v2:

```yaml
tools:
  - name: prettier
    command: npx prettier --check {changed_files}
```

### AI Provider Rules

- `ai.mode` supports `blocking`, `advisory`, and `off`.
- Active local AI config selects a provider with `ai.provider`.
- Provider-specific settings live below `ai.providers.<provider>`.
- When local AI is active, the selected provider must have a matching provider
  block.
- When `ai.mode` is `off`, provider config may be omitted. If it is present, it
  must still be structurally valid.
- Provider invocation, auth behavior, result formatting, and adapter-specific
  validation beyond this config boundary belong to later AI issues.

## Legacy Config Behavior

`.pushgate.yml` is the v2 config source.

| Files in repo | Config loader behavior |
|---|---|
| `.pushgate.yml` only | Parse and validate v2 config. |
| `.push-review.yml` only | Fail with migration guidance. |
| Both files | Parse `.pushgate.yml` and warn that `.push-review.yml` is legacy. |
| Neither file | Report the missing v2 config according to the loader contract selected during implementation. |

The legacy file must not silently become v2 vocabulary or pass through the v2
schema parser as if it were `.pushgate.yml`.

## Execution Plan

1. Add the Node config module structure and its test runner dependencies.
2. Add the formal v2 config schema artifact.
3. Encode the runtime validation and normalization path for `.pushgate.yml`.
4. Define typed internal config output that later deterministic and AI layers
   can consume without parsing YAML again.
5. Add legacy-file detection and migration-facing diagnostics.
6. Add fixture coverage for valid configs, normalized defaults, and invalid
   config errors.
7. Document the v2 config surface and keep README/template changes scoped to
   what this schema freeze makes true.

## Test Coverage

The config test suite should cover:

- a representative valid v2 config;
- default normalization;
- comments;
- multiline lists;
- nested provider objects;
- unsupported or missing config versions;
- missing required keys;
- unknown core keys;
- invalid enum values;
- string commands and other unsafe command shapes;
- provider selection without a matching provider block;
- `ai.mode: off` without provider config;
- legacy-only `.push-review.yml` migration guidance; and
- both config files existing together.

## Expected Result

After issue #2, later Pushgate work should be able to depend on one versioned
Node config boundary:

1. Parse `.pushgate.yml`.
2. Validate it against the formal v2 schema.
3. Normalize it into typed config.
4. Stop with actionable diagnostics when config is invalid or legacy-only.

The runner, deterministic checks, and AI provider adapters can then consume
that typed contract instead of reparsing YAML or encoding their own config
interpretation.

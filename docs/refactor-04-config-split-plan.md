# Refactor 04 Config Split Plan

This document turns the config-loader simplification into a concrete PR plan.

The goal is to split config loading into load, validate, and normalize responsibilities while preserving the public `./config` export and existing config error behavior.

## Verified Context

The generated graph marks `src/config/index.ts` as a complex configuration-contract node. Source inspection shows it currently owns:

| Concern | Current examples |
|---|---|
| Public re-exports | Config types from `src/config/types.ts` |
| Constants | `CONFIG_FILENAME`, `LEGACY_CONFIG_FILENAME` |
| Schema setup | AJV instance and compiled v2 schema |
| Error classes | `ConfigError`, `ConfigValidationError`, `MissingConfigError`, `LegacyConfigError` |
| YAML parsing | `parseDocument` and YAML diagnostic mapping |
| Schema validation | AJV validation and schema error formatting |
| Provider validation | Active AI provider selection checks |
| Disk loading | `.pushgate.yml` and `.push-review.yml` lookup |
| Normalization | Defaults for review, tools, policies, AI, and ignore paths |
| Defensive cloning | Provider extension block cloning |

The existing `test/config.test.ts` suite covers representative config parsing, defaults, schema failures, provider selection, legacy config detection, missing config handling, and templates.

## Scope Boundaries

In scope:

- Split config modules by responsibility.
- Keep `src/config/index.ts` as the public facade.
- Preserve all exported type names, constants, functions, and error classes.
- Preserve exact config defaults.
- Preserve current validation timing: schema validation, then normalization, then provider-selection validation.

Out of scope:

- Do not change `.pushgate.yml` schema shape.
- Do not change provider config extension semantics.
- Do not migrate or parse `.push-review.yml`.
- Do not change template contents.
- Do not add a new config source or environment override.

## Proposed Files

Add:

| New file | Responsibility |
|---|---|
| `src/config/constants.ts` | `CONFIG_FILENAME` and `LEGACY_CONFIG_FILENAME` |
| `src/config/errors.ts` | Config error classes |
| `src/config/validation.ts` | YAML parsing, AJV validation, schema diagnostic formatting, provider-selection validation |
| `src/config/normalize.ts` | Raw-to-normalized `PushgateConfig` defaulting and cloning |
| `src/config/load.ts` | Repository disk lookup, legacy detection, warnings, and `loadConfig` |
| `src/config/index.ts` | Public facade for existing imports |

Keep:

| Existing file | Desired final role |
|---|---|
| `src/config/types.ts` | Raw and normalized config type definitions |
| `schemas/pushgate-config-v2.schema.json` | Source of schema truth |
| `docs/v2-config-schema.md` | Human-readable schema contract |

## Proposed Dependency Direction

```text
index.ts
  -> constants.ts
  -> errors.ts
  -> load.ts
  -> validation.ts
  -> normalize.ts
  -> types.ts

load.ts -> constants.ts, errors.ts, validation.ts
validation.ts -> errors.ts, normalize.ts, types.ts, schema json
normalize.ts -> types.ts
```

`normalize.ts` should not import AJV or filesystem APIs. `load.ts` should not know how defaults are applied.

## Execution Plan

1. Extract constants and errors.
   - Move `CONFIG_FILENAME`, `LEGACY_CONFIG_FILENAME`, and error classes.
   - Re-export them from `index.ts`.
   - Preserve constructor messages exactly.

2. Extract normalization.
   - Move `normalizeConfig`, `normalizePolicies`, and `cloneValue`.
   - Keep helper exports internal unless tests need direct access.

3. Extract validation.
   - Move AJV setup, `parseConfigYaml`, `validateProviderSelection`, and `formatSchemaError`.
   - Keep `parseConfigYaml` public through `index.ts`.
   - Keep provider-selection diagnostics unchanged.

4. Extract loading.
   - Move `loadConfig` and `exists` into `load.ts`.
   - Import constants and parse function from the new modules.
   - Keep legacy warning text unchanged.

5. Simplify `index.ts`.
   - Re-export public config types from `types.ts`.
   - Re-export public constants, errors, `parseConfigYaml`, and `loadConfig`.

6. Run validation.
   - `pnpm test`
   - Optionally run `tsx --test test/config.test.ts` during iteration.

## Acceptance Criteria

- `pnpm test` passes.
- Existing imports from `../src/config/index.js` still work.
- `test/config.test.ts` needs no behavior assertion changes.
- `src/config/index.ts` becomes a facade rather than the implementation home for load, validate, and normalize.
- `normalize.ts` can be understood without reading filesystem or AJV code.

## Graph Scorecard

After this PR, the graph should show the Configuration Contract layer as several smaller nodes instead of one dense `src/config/index.ts` node. The config layer should remain separate from Runtime Execution and AI Review Engine.

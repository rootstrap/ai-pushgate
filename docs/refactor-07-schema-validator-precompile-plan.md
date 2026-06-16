# Refactor 07 Schema Validator Precompile Plan

This document turns the schema-runtime simplification into a concrete PR plan.

The goal is to keep the config and AI review validation interfaces intact while moving the heavy runtime `ajv` implementation out of the bundled runner. Validation has strong leverage, but the current runtime dependency makes `bin/pushgate.mjs` much larger and harder to navigate.

## Verified Context

The generated runner includes thousands of dependency lines before Pushgate source begins. A large share comes from runtime `ajv` usage in `src/config/validation.ts` and `src/ai/review-output.ts`.

| Concern | Current state |
|---|---|
| Config schema | `schemas/pushgate-config-v2.schema.json` is compiled at runtime by `src/config/validation.ts`. |
| AI output schema | `schemas/ai-review-output-v1.schema.json` is compiled at runtime by `src/ai/review-output.ts`. |
| Validation interface | Callers use `parseConfigYaml` and `parseAiReviewOutput`; they do not need to know how validators are built. |
| Bundle cost | Runtime `ajv` implementation is bundled into `bin/pushgate.mjs`. |
| Tests | `test/config.test.ts`, `test/ai.test.ts`, `test/runner.test.ts`, and hook tests cover validation behavior. |

This is a deepening opportunity: generated validator adapters can preserve the small validation interface while hiding schema implementation detail.

## Scope Limits

In scope:

- Generate standalone validators for the existing config and AI review schemas.
- Keep the public validation interfaces unchanged.
- Preserve validation errors and diagnostics as closely as practical.
- Keep schemas as the source of truth.
- Update build and test scripts so generated validators stay fresh.

Out of scope:

- Do not change `.pushgate.yml` schema shape.
- Do not change the AI review output schema.
- Do not add new config sources or AI finding categories.
- Do not change local AI mode behavior or terminal rendering.
- Do not remove `ajv` from development dependencies until the generation path is stable.

## Proposed Files

Add:

| New file | Responsibility |
|---|---|
| `scripts/build-validators.mjs` | Generate standalone validator modules from JSON schemas. |
| `src/generated/pushgate-config-v2-validator.ts` | Generated adapter for the v2 config schema. |
| `src/generated/ai-review-output-v1-validator.ts` | Generated adapter for the AI review output schema. |
| `src/generated/README.md` | Explain generated validator provenance if generated files are checked in. |

Modify:

| Existing file | Desired final role |
|---|---|
| `src/config/validation.ts` | Parse YAML, call generated config validator, format diagnostics. |
| `src/ai/review-output.ts` | Parse and repair provider output, call generated AI review validator, format diagnostics. |
| `package.json` | Add validator generation to build and test flow. |
| `scripts/build-runner.mjs` | Bundle generated validators instead of runtime schema compiler code. |

## Proposed Adapter Shape

The generated modules should stay behind a small adapter interface:

```ts
export interface SchemaValidationResult {
  valid: boolean;
  errors?: readonly SchemaValidationError[];
}

export function validatePushgateConfig(value: unknown): SchemaValidationResult;
export function validateAiReviewOutput(value: unknown): SchemaValidationResult;
```

The exact error shape can mirror what generated `ajv` standalone output exposes, but callers should not import `ajv` types directly.

## Execution Plan

1. Spike standalone generation in isolation.
   - Use `ajv/dist/standalone` or equivalent supported standalone generation.
   - Generate one validator for each existing schema.
   - Confirm the generated modules can be imported by TypeScript and bundled by esbuild.

2. Add a small generated-validator adapter.
   - Normalize generated validation output into local error objects.
   - Keep `src/config/validation.ts` and `src/ai/review-output.ts` free of runtime `Ajv` construction.
   - Preserve the existing validation interface for callers and tests.

3. Preserve diagnostics.
   - Compare current schema error text against generated-validator error text.
   - Keep user-facing messages stable where tests already assert them.
   - If generated errors differ, centralize translation in the validation modules.

4. Wire generation into build.
   - Add `pnpm run build:validators`.
   - Run validator generation before TypeScript build and bundle.
   - Decide whether generated files are checked in or generated during build only.

5. Measure the bundle.
   - Rebuild `bin/pushgate.mjs`.
   - Confirm runtime `ajv` implementation no longer dominates the generated runner.
   - Record before and after line count or metafile summary in the PR.

6. Validate behavior.
   - `pnpm test`
   - Targeted checks: `test/config.test.ts`, `test/ai.test.ts`, `test/runner.test.ts`.

## Acceptance Criteria

- Runtime validation behavior remains compatible with existing tests.
- `src/config/validation.ts` and `src/ai/review-output.ts` no longer construct runtime `Ajv` instances.
- The generated runner is materially smaller or its bundle metafile shows runtime `ajv` removal.
- Schema files remain the source of truth.
- `pnpm test` passes after a clean checkout and build.

## Graph Scorecard

After this PR, the config contract and AI review output modules should keep the same external seam, but schema implementation should move behind generated validator adapters. Locality improves because schema generation, schema diagnostics, and caller behavior become separate reasons to edit separate modules.

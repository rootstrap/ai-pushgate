# Distribution Runner

`bin/pushgate.mjs` is the installer-facing Pushgate runner. It is checked in so
`install.sh` can install a single managed command for Git hooks without a
project-local build step or installed Node dependencies.

The source of truth is TypeScript under `src/`, with `src/cli.ts` as the bundle
entry point. `scripts/build-runner.mjs` uses esbuild to produce the single-file
runner.

## Regenerating

```sh
pnpm run bundle
```

The generated file keeps its shebang first so it remains directly executable.
Do not edit `bin/pushgate.mjs` by hand. Update `src/` or schemas, then rebuild.

## Inspecting Bundle Composition

```sh
pnpm run bundle:analyze
```

The analysis command rebuilds the runner with esbuild metafile output, then
writes ignored artifacts:

- `dist/bundle-analysis/pushgate-metafile.json`
- `dist/bundle-analysis/pushgate-analysis.txt`

Use the text report for a quick size scan and the JSON metafile for custom
tooling.

## Generated Files

Two generated surfaces are intentionally checked in:

- `bin/pushgate.mjs` is the installer-facing runner artifact.
- `src/generated/*-validator.ts` contains schema validators generated from
  `schemas/*.schema.json`.

Architecture graphs and docs should treat generated files as distribution
artifacts, not as the implementation source of truth.

## Freshness

`pnpm test` runs `pnpm run typecheck`, then `pnpm run bundle`, then the Node
test suite. `test/runner.test.ts` executes the generated runner directly, so the
installed artifact remains inside the tested surface while source changes stay
localized under `src/`.

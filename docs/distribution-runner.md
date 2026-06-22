# Distribution Runner

`bin/pushgate.mjs` is the installer-facing Pushgate runner. It is checked in so
`install.sh` can install a single managed command for Git hooks without
depending on a project-local build step or installed Node dependencies.

The source of truth is the TypeScript implementation under `src/`, with
`src/cli.ts` as the bundle entry point. `scripts/build-runner.mjs` uses esbuild
to produce the single-file runner.

## Regenerating

```bash
pnpm run bundle
```

The generated file keeps its shebang first so it remains directly executable.
Do not edit `bin/pushgate.mjs` by hand; update `src/` and rebuild it.

## Inspecting Bundle Composition

```bash
pnpm run bundle:analyze
```

The analysis command rebuilds the runner with esbuild metafile output, then
writes these ignored artifacts:

- `dist/bundle-analysis/pushgate-metafile.json`
- `dist/bundle-analysis/pushgate-analysis.txt`

Use the text report for a quick size scan and the JSON metafile for custom
tooling. The current bundle is dominated by esbuild runtime helpers, `ajv`,
`yaml`, `ignore`, and Pushgate source modules, so large runner diffs are normal
when dependency or schema code changes.

## Architecture Analysis

`bin/pushgate.mjs` remains tracked and tested because it is the
installer-facing distribution artifact. Architecture graphs and documentation
workflows should treat the TypeScript files under `src/` as the implementation
truth, then collapse or exclude generated internals such as `bin/pushgate.mjs`
and `src/generated/*-validator.ts`.

Do not edit generated files by hand. Update the source modules, schemas, or
build scripts, then regenerate the artifacts.

## Freshness

`pnpm test` runs `pnpm run bundle` before executing the Node test suite, and
`test/runner.test.ts` executes the generated runner directly. That keeps the
installed runner artifact inside the tested surface while source changes remain
localized in `src/`.

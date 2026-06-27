# Checked-In Generated Runner

Pushgate checks in `bin/pushgate.mjs` because the installer needs a single
runner artifact that can be downloaded and executed without project-local
dependencies. The TypeScript source under `src/` remains the implementation
truth, and the generated runner is rebuilt from that source.

## Consequences

Generated runner diffs are expected when source, dependencies, schemas, or
build tooling change. Do not edit the generated runner by hand; update source
or schemas and regenerate it.

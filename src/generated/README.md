# Generated Validators

The TypeScript files in this directory are generated from the JSON schemas in
`schemas/` by running:

```sh
pnpm run build:validators
```

Ajv is used at generation time to produce standalone validator functions. The
runtime modules expose small adapters so config parsing and AI review parsing do
not construct Ajv instances in the bundled runner.

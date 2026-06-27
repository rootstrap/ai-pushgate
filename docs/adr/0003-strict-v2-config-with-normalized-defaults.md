# Strict V2 Config With Normalized Defaults

Pushgate uses `.pushgate.yml` as the v2 public config surface. The loader
validates it against a strict schema, rejects unknown core keys, normalizes
defaults before downstream modules read it, and treats `.push-review.yml` as
legacy migration input rather than an alternate runtime format.

## Considered Options

- Accept loose YAML and let each module interpret missing or unknown fields.
- Validate once at the config boundary and hand every module a normalized
  `PushgateConfig`.

## Consequences

Downstream modules can assume defaults are present and active AI provider
selection has already been validated. Adding public config requires schema,
normalization, docs, and tests to change together.

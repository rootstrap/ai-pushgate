# Centralized Changed-File Resolution

Pushgate resolves changed files once from the selected review target and shares
that normalized result with deterministic checks and local AI. The path policy
module owns target-ref resolution, merge-base selection, diff parsing, ignore
filtering, and named review and scan ranges. ADR 0007 describes how the
workflow chooses that review target before this resolver runs.

## Considered Options

- Let each phase run its own Git commands and choose its own range.
- Resolve once and pass domain-level changed-file facts to phases.

## Consequences

Pushgate fails explicitly when the selected review target ref or merge base is
unavailable. It does not fetch, guess a remote, or silently switch ranges.
Consumers use `reviewRange` and `scanRange` instead of rebuilding Git syntax
themselves.

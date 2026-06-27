# Pushgate Docs

These docs capture durable Pushgate knowledge: domain language, architecture,
reference contracts, and decisions that explain why the system has its current
shape.

They complement source comments and TSDoc. Do not remove useful code comments
just because related reference material exists here.

The docs are intentionally not an issue tracker. Temporary implementation
plans, refactor prompts, demo notes, and ticket briefs should live outside this
directory unless they are distilled into one of the maintained doc types below.

## Start Here

- [Domain Model](./domain/model.md) explains what Pushgate is in product terms.
- [Domain Glossary](../CONTEXT.md) defines the canonical language used in code,
  docs, and tickets.
- [Architecture Overview](./architecture/overview.md) gives the system map.
- [Runtime Flow](./architecture/runtime-flow.md) follows one push from Git hook
  to final local verdict.
- [Module Map](./architecture/modules.md) lists the main modules and stable
  interfaces.

## Decisions

Architecture decisions live in [ADR](./adr/):

- [0001 - Local Hook Delegates To Managed Runner](./adr/0001-local-hook-delegates-to-managed-runner.md)
- [0002 - Local Gate Is Not Final Enforcement](./adr/0002-local-gate-is-not-final-enforcement.md)
- [0003 - Strict V2 Config With Normalized Defaults](./adr/0003-strict-v2-config-with-normalized-defaults.md)
- [0004 - Centralized Changed-File Resolution](./adr/0004-centralized-changed-file-resolution.md)
- [0005 - Provider-Neutral Local AI Review Contract](./adr/0005-provider-neutral-local-ai-review-contract.md)
- [0006 - Checked-In Generated Runner](./adr/0006-checked-in-generated-runner.md)

## Reference

- [Configuration Reference](./reference/configuration.md) documents
  `.pushgate.yml`.
- [Changed-File Policy](./reference/changed-file-policy.md) documents Git range,
  ignore, and live-path semantics.
- [Local AI Review](./reference/local-ai-review.md) documents provider behavior,
  guardrails, and the structured output contract.
- [Distribution Runner](./architecture/distribution.md) documents
  `bin/pushgate.mjs` and regeneration.

## What To Keep Tracking

Keep these docs current as the product changes:

- **Domain model**: update when user-facing terms or push-gate outcomes change.
- **ADRs**: add one only when a decision is hard to reverse, non-obvious without
  context, and the result of a real trade-off.
- **Architecture docs**: update when module responsibility or runtime order
  changes.
- **Reference docs**: update alongside schema, provider, path-policy, or
  distribution changes.
- **Support diagnostics**: add a focused reference doc when helper commands,
  debug artifacts, or support workflows become part of the product.
- **CI/PR parity**: add a focused doc when Pushgate starts emitting or checking
  remote enforcement guidance.

Do not keep one-off implementation plans, refactor wishlists, delegated-agent
briefs, generated analysis exports, or ticket drafts in this directory. If they
contain a lasting decision, promote that decision into an ADR or reference doc
and delete the draft.

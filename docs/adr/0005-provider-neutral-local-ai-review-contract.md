# Provider-Neutral Local AI Review Contract

Pushgate normalizes Claude, Copilot, and future provider output into one local
AI review contract before building a verdict. Provider adapters may use
different command arguments and transports, but the rest of Pushgate consumes
the same schema-versioned findings and provider-neutral failure codes.

## Considered Options

- Let each provider define its own output shape and transcript behavior.
- Require every provider to satisfy one Pushgate-owned output contract.

## Consequences

The review contract, prompt, local validation, and provider adapters must stay
aligned. Providers with native schema support can enforce the contract earlier,
but Pushgate still validates responses locally before consuming findings.

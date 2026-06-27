# Agent Notes

## Documentation

- Keep useful TSDoc and inline comments in source. They are part of the
  codebase's readability and AI-navigation surface.
- Add or improve TSDoc for exported types, functions, classes, and domain
  contracts when it helps callers understand invariants, error modes, or
  configuration semantics.
- Use `docs/` for durable architecture, domain, ADR, and reference material.
  The docs directory complements TSDoc; it does not replace comments that belong
  next to code.

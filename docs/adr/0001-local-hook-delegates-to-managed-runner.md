# Local Hook Delegates To Managed Runner

Pushgate keeps the repository `pre-push` hook as a small delegator and puts
runtime behavior behind a managed `pushgate` runner. This lets policy, config
validation, path handling, deterministic checks, and local AI evolve in
TypeScript without repeatedly rewriting shell hook logic in every installed
repository.

## Considered Options

- Keep all behavior in the shell hook. This is simple to install but makes
  config parsing, timeouts, provider execution, and testing much harder.
- Delegate from the hook to a managed runner. This adds runner installation and
  protocol compatibility, but gives the codebase a real implementation surface.

## Consequences

The hook must check runner existence, executability, and hook protocol before
delegating. The installer must keep the managed runner and hook compatible.

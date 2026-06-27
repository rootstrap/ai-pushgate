# Local Gate Is Not Final Enforcement

Pushgate treats local push-gate results as fast developer feedback, not final
policy enforcement. Git hooks can be bypassed with `git push --no-verify`, so CI
and PR policy remain the final enforcement layer for repository rules.

## Consequences

Pushgate docs must be honest about bypasses. Local `blocking` results improve
the default workflow, but security or compliance guarantees must be mirrored in
remote enforcement.

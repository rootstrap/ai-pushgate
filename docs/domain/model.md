# Pushgate Domain Model

Pushgate is a local push gate. It gives developers fast feedback during a
normal `git push`, before commits reach CI, branch protection, or pull request
review.

Pushgate does not replace remote enforcement. Local hooks can be bypassed, and
the product treats that as a Git reality rather than pretending otherwise.

## Operating Model

1. A developer runs `git push`.
2. Git invokes the repository's `pre-push` hook unless the push uses
   `--no-verify`.
3. The hook delegates to the Pushgate runner.
4. Pushgate loads repository config and evaluates the push locally.
5. Deterministic checks run before local AI review.
6. Blocking results stop the push. Warning results require explicit terminal
   confirmation before the push continues.
7. The transcript explains what ran, what was skipped, and why the push passed
   or failed.

## Core Relationships

| Concept | Relationship |
|---|---|
| Push | The developer action Pushgate evaluates locally. |
| Pre-Push Hook | The Git entry point that delegates to the runner. |
| Pushgate Runner | The executable that owns config loading, phase order, and local verdicts. |
| Pushgate Config | Repository-owned policy for deterministic checks, local AI, path filtering, and provider settings. |
| Changed-File Resolution | One normalized view of changed files and Git ranges shared by deterministic checks and local AI. |
| Deterministic Check | A local check whose result does not depend on a language model. |
| Local AI Review | A provider-backed review phase that runs only after deterministic checks pass. |
| Transcript | The user-facing explanation of the local push-gate run. |

The canonical glossary is [CONTEXT.md](../../CONTEXT.md). Use those terms in
docs, issues, and code comments.

## Local Outcomes

| Outcome | Meaning |
|---|---|
| Pass | No blocking result remains and any warnings were confirmed. |
| Warn | A configured check or local AI review found something non-blocking that still requires developer acknowledgement. |
| Block | A blocking check, blocking AI finding, provider failure in blocking mode, or missing confirmation stopped the push. |
| Skip | A configured mode, guardrail, or one-push skip control intentionally bypassed a phase. |

## Boundary Rules

- `git push` is the normal workflow. `pushgate push` is a convenience wrapper
  that runs the same local Pushgate workflow before opening the native Git push,
  then delegates with `git push --no-verify` after Pushgate passes.
- `git push --no-verify` bypasses the hook entirely and is outside Pushgate's
  runtime control.
- `pushgate.skip-all-checks` skips all local Pushgate work for one push.
- `pushgate.skip-ai-check` skips only local AI review for one push.
- `.pushgate.yml` is the public config vocabulary. `.push-review.yml` is legacy
  migration input, not an alternate runtime format.
- Pushgate resolves changed files from locally available Git state. It does not
  fetch, guess a remote, or silently choose a fallback range.

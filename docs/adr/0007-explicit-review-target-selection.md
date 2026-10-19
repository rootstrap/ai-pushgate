# Explicit Review Target Selection

Pushgate selects one review target before changed-file resolution when local Git
state makes more than one target plausible.

## Context

The original resolver compared `HEAD` with the configured local
`review.target_branch`, usually `main`. That is simple, but it can review the
wrong range when local `main` is stale, when the destination branch already
exists and the developer wants only the incremental push reviewed, or when a
branch is stacked on top of another feature branch.

Silently switching from the configured target to a remote-tracking ref or
incremental base would make the transcript harder to trust.

## Decision

Pushgate keeps `review.target_branch` as the configured default and introduces
per-push review target selection.

When changed-file resolution is needed, Pushgate diagnoses locally available Git
state without fetching. It prompts only when there is ambiguity:

- the configured target is behind or diverged from its fetched remote target
- the destination branch already has a remote object id
- likely stacked remote ancestor branches exist

The selected review target is used for all changed-file consumers: deterministic
checks, plugins, built-in policies, and local AI review. The transcript prints
the chosen review target plus the resulting review and scan ranges.

`pushgate.review-target=<ref>` is a one-push override that skips terminal
selection but does not persist.

## Consequences

Pushgate does not fetch or mutate refs during a pre-push hook run. Stale-target
diagnostics tell the developer to run `git fetch` and update the local target
before retrying.

Non-interactive ambiguous pushes fail closed with override guidance instead of
guessing a review target.

Stacked PR support is heuristic: Pushgate shows the closest remote branches
whose tips are ancestors of `HEAD`, excluding the current branch remote and the
target remote.

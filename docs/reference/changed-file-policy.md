# Changed-File Policy

Changed-file policy is the module-level contract for converting local Git state
into the file and range facts Pushgate phases consume.

## Resolution Contract

Before `resolveChangedFiles` runs, the workflow selects one review target for
the push. In the simple case that target is `review.target_branch`. When local
state is ambiguous, Pushgate asks the developer to choose from the configured
target, the fetched remote target, the destination branch tip for incremental
push review, likely stacked remote ancestors, or an advanced custom ref.

`resolveChangedFiles` receives a repository root, the selected review target,
and `ignore_paths`. It returns one `ChangedFileResolution`:

| Field | Meaning |
|---|---|
| `targetRef` | Selected review target branch, ref, or commit. |
| `targetCommit` | Commit selected by the review target at resolution time. |
| `diffBase` | Merge base selected by the `<target>...HEAD` diff contract. |
| `files` | Globally filtered changed files for deterministic and AI consumers. |
| `reviewRange` | Git range used to prepare human-readable local AI review context. |
| `scanRange` | Git range used by deterministic scanners that inspect pushed commits. |

The review target must already exist in local Git state. Pushgate fails with an
explicit diagnostic if the ref is missing or there is no usable merge base with
`HEAD`. It does not fetch or silently switch to a different history range.

## Review Target Selection

Pushgate compares the configured target branch with its remote counterpart when
both refs exist locally. It maps `main` to `main@{upstream}` first, then falls
back to `<push-remote>/main`. It warns when the configured target is behind or
diverged from the fetched remote-tracking target and suggests running
`git fetch`.

Pushgate prompts for a review target only when changed-file resolution is needed
and one of these ambiguities exists:

- the configured target is behind or diverged from its fetched remote target
- the destination branch already exists, so incremental review is possible
- likely stacked bases exist among remote branches whose tips are ancestors of
  `HEAD`

For incremental review, pre-push stdin's remote object id is preferred over a
remote-tracking ref. If stdin is unavailable or incomplete, Pushgate falls back
to `<push-remote>/<current-branch>` when that ref exists locally.

`git -c pushgate.review-target=<ref> push` selects a review target for one push
and skips the terminal selection prompt. Diagnostics still print when Pushgate
can determine that the configured target is stale.

## Range Semantics

| Range | Shape | Used by | Why |
|---|---|---|---|
| Review range | `<target-commit>...HEAD` | Local AI diff context | Gives the reviewer the same changed-file view Pushgate resolved from the configured target. |
| Scan range | `<merge-base>..HEAD` | Commit scanners such as Gitleaks | Lets scanners inspect every pushed commit, including secrets added and later removed before the final diff. |

Consumers should use the named ranges on `ChangedFileResolution` instead of
reconstructing Git syntax themselves.

## Changed Files

Each changed file contains:

| Field | Meaning |
|---|---|
| `path` | Repository-relative path with Git's slash-separated path spelling. |
| `previousPath` | Prior path when Git identifies a rename or copy. |
| `status` | Normalized Git status: `added`, `copied`, `deleted`, `modified`, `renamed`, `type-changed`, `unmerged`, or `unknown`. |
| `additions` | Added text lines from Git numstat, or `null` for binary diffs. |
| `deletions` | Deleted text lines from Git numstat, or `null` for binary diffs. |
| `binary` | Whether Git numstat identifies the diff as binary. |

Deleted files stay in `files` so diff context and AI review can reason about
removals. Live-path consumers filter them out before passing paths to tools.

## Ignore Paths

`ignore_paths` uses gitignore-like rules against Git's repo-relative paths.
Patterns such as `*.lock` match basenames across the changed tree. Directory
rules such as `dist/**` remove generated subtrees before deterministic checks or
AI consume the changed-file list.

Ignore filtering is global. If a path is ignored here, configured tools,
built-in policies, plugins that use changed-file lists, and local AI do not see
it as a changed file.

## Live Tool Paths

Configured tools receive live current paths only. `selectToolChangedFilePaths`
removes deleted files and applies optional `tools[].extensions` suffix filters.

This means a tool with `run: changed_files` is skipped when no non-deleted
changed file matches its extension filter. A tool with `run: always` still runs,
and `{changed_files}` expands to zero or more argv entries.

## Platform Scope

The current path-policy implementation targets macOS and Linux behavior.
Windows and Git Bash path support remain explicit follow-up scope for parser,
timeout, path glob, and packaging decisions.

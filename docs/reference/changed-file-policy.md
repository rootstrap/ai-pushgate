# Changed-File Policy

Changed-file policy is the module-level contract for converting local Git state
into the file and range facts Pushgate phases consume.

## Resolution Contract

`resolveChangedFiles` receives a repository root, `review.target_branch`, and
`ignore_paths`. It returns one `ChangedFileResolution`:

| Field | Meaning |
|---|---|
| `targetRef` | Configured target branch or ref. |
| `targetCommit` | Commit selected by the configured target ref at resolution time. |
| `diffBase` | Merge base selected by the `<target>...HEAD` diff contract. |
| `files` | Globally filtered changed files for deterministic and AI consumers. |
| `reviewRange` | Git range used to prepare human-readable local AI review context. |
| `scanRange` | Git range used by deterministic scanners that inspect pushed commits. |

The target ref must already exist locally. Pushgate fails with an explicit
diagnostic if the ref is missing or there is no usable merge base with `HEAD`.
It does not fetch, guess a remote variant, or switch to a different history
range.

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

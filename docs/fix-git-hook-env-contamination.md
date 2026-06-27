# Fix Git Hook Environment Contamination

## Summary

Pushgate must not forward Git hook-local repository binding variables into subprocesses that run outside the hook's own Git push operation. When variables such as `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, or `GIT_COMMON_DIR` leak into configured tools, plugins, providers, or repo-targeted Git helpers, nested Git commands can operate on the repository being pushed instead of the subprocess `cwd`.

This fix is independent from CLI logging work. It is a safety and correctness change with no config schema changes.

## Implementation

- Add `sanitizeGitLocalEnv(env)` in `src/git/environment.ts`.
- Strip variables reported by `git rev-parse --local-env-vars`, including `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_CONFIG`, and `GIT_CONFIG_COUNT`.
- Strip dynamic `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` entries.
- Preserve transport and auth variables such as `GIT_SSH_COMMAND`, `GIT_ASKPASS`, and `GIT_TERMINAL_PROMPT`.
- Sanitize external Pushgate subprocesses:
  - configured deterministic tools
  - Gitleaks plugin command
  - AI provider CLI commands
- Sanitize repo-targeted internal Git helpers through the shared `runGit` wrapper.
- Leave the native `git push` wrapper unsanitized because it intentionally runs Git's push operation in the caller's context.
- Keep Git-spawning test helpers safe when tests are launched from a Git hook.

## Test Plan

- Unit-test `sanitizeGitLocalEnv`.
- Regression-test a configured tool running nested Git with a poisoned parent Git environment.
- Verify Gitleaks and AI provider command stubs do not receive hook-local Git repository variables.
- Run `pnpm run typecheck`.
- Run `pnpm test`.
- Run `pnpm run check:shell`.

## Manual Acceptance

After the fix, running `git push` in `ai-pushgate` may pass or fail checks normally, but Pushgate subprocesses must not create `baseline` commits, switch or create `feature`, delete fixture paths, or leave index locks in the real repository because of inherited hook-local Git variables.

## Description

<!-- What does this PR do? Why is it needed? Be concise but complete.
     Link any related issues with "Closes #123" or "Fixes #123". -->

## Type of change

<!-- Check all that apply -->

- [ ] `fix:` — Bug fix (patch version bump)
- [ ] `feat:` — New feature (minor version bump)
- [ ] `feat!:` / `fix!:` — Breaking change (major version bump)
- [ ] `docs:` — Documentation only (no version bump)
- [ ] `chore:` — Maintenance or config (no version bump)
- [ ] `refactor:` — Code restructure, no behaviour change (no version bump)

## Changes made

<!-- List the specific files changed and what was done to each.
     This helps reviewers know where to focus. -->

-
-

## Testing

<!-- How did you verify this works? What edge cases did you consider? -->

- [ ] `pnpm test` passes
- [ ] `bash -n hook/pre-push` passes with no output
- [ ] `bash -n install.sh` passes with no output
- [ ] Manually tested the hook on a real repository
- [ ] Tested on macOS
- [ ] Tested on Linux

## Checklist

- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org)
- [ ] No `eval`, heredoc variable expansion, or unquoted variable interpolation in shell scripts
- [ ] File lists passed as arrays, never as interpolated strings
- [ ] `VERSION`, `CHANGELOG.md`, `.release-please-manifest.json`, and `release-please-config.json` were **not** manually edited — these are managed by release-please
- [ ] New template added to the table in `README.md` _(if applicable)_
- [ ] New template name added to `install.sh` usage comment _(if applicable)_

## Screenshots / output

<!-- If your change affects terminal output, paste a before/after example here. -->

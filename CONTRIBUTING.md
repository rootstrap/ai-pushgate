# Contributing to ai-pushgate

Thank you for your interest in contributing! This document covers everything
you need to know to get changes merged.

---

## How to contribute

All changes — including from maintainers — must go through a pull request. Direct pushes to `main` are not allowed. Every PR runs automated checks via GitHub Actions to validate shell syntax and script integrity before merging.

---

## Development setup

```bash
git clone git@github.com:rootstrap/ai-pushgate.git
cd ai-pushgate

# Let Corepack use the pnpm version pinned in package.json
corepack enable
pnpm install
```

Pushgate uses pnpm for its Node config parser, runner tests, and scripts. The
installed command is a small Node entrypoint, the hook and installer are shell,
and templates remain YAML.

---

## Commit messages

This project uses [Conventional Commits](https://www.conventionalcommits.org).
`release-please` reads your commit messages to determine version bumps and
generate the changelog automatically, so following the convention is important.

| Prefix | When to use | Version bump |
|---|---|---|
| `fix:` | Bug fix in the hook or installer | Patch |
| `feat:` | New feature or template | Minor |
| `feat!:` or `fix!:` | Breaking change | Major |
| `docs:` | Documentation only | None |
| `chore:` | Maintenance, config, CI | None |
| `refactor:` | Code restructure, no behaviour change | None |

Examples:
```
feat: add python template
fix: handle filenames with spaces in tool runner
docs: add troubleshooting section to README
feat!: require Claude Code CLI — remove fallback to allow push
```

---

## What you can contribute

### Adding a new template

Templates live in `templates/` and are downloaded by `install.sh` when a user
passes `--template <name>`. To add one:

1. Create `templates/<name>.yml` based on an existing template
2. Populate the `tools:` section with the stack's standard linters and test runners
3. Add appropriate `ignore_paths:` for generated or vendored files
4. Add a row to the templates table in `README.md`
5. Add the new template name to the `--template` usage comment in `install.sh`

Keep templates self-contained — no inheritance, no references to other files.
Each template should be a ready-to-use starting point that a developer can
commit as-is and customise from there.

### Fixing the hook script

`hook/pre-push` is the thin delegator between Git and the managed Pushgate
runner. Before making changes:

- Run `bash -n hook/pre-push` to validate syntax before committing
- Keep hook arguments, stdin, and exit codes intact across the runner boundary
- Keep missing-runner and incompatible-protocol diagnostics actionable
- Avoid adding policy execution back into the installed hook

### Fixing the installer

`install.sh` follows the same shell safety rules as the hook. Additionally:
- It must work when piped through `bash` (`curl ... | bash`)
- It must not assume any tools beyond `bash`, `curl`, `git`, and `node` are available

---

## Testing your changes

Run the automated tests before manual hook or installer checks:

```bash
# Install config parser dependencies
pnpm install

# Typecheck the Node layer, validate config fixtures, and run the hook harness
# against disposable Git repos and local tool/provider stubs
pnpm test

# Validate shell syntax
pnpm run check:shell

# Run ShellCheck's error-level static checks when ShellCheck is installed
pnpm run lint:shell

# Test the installer locally (from inside a git repo)
bash install.sh --template node

# Test the hook by installing it and making a push
bash install.sh --template node
git push
```

For template changes, install the template into a representative project and
verify the configured tools run correctly against changed files.

---

## Pull request checklist

- [ ] `pnpm test` passes
- [ ] `pnpm run check:shell` passes with no output
- [ ] `pnpm run lint:shell` passes when ShellCheck is installed
- [ ] Commit messages follow Conventional Commits
- [ ] New templates include all keys from an existing template
- [ ] `README.md` updated if a new template was added
- [ ] `install.sh` usage comment updated if a new template was added

---

## Releases

Releases are fully automated via `release-please`. When your PR is merged to
`main`, release-please analyses the commit messages and opens a Release PR if
there is anything releasable. Merging the Release PR creates the GitHub Release
and git tag automatically — you don't need to do anything manually.

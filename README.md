# ai-pushgate

A language-agnostic push gate for regular git push workflows. An installed pre-push hook runs local checks and AI review before the push proceeds, helping clean up obvious issues early and prevent sensitive or unwanted changes from reaching the next layer of review.

## How it works

```
git push
    │
    ▼
┌─────────────────────────────────────┐
│  Changed files vs target branch     │
│  (ignore_paths filtering applied)   │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Run configured tools               │
│  (linters, type checkers, tests)    │
│  ✗ any failure → push blocked       │
└──────────────┬──────────────────────┘
               │ all pass
               ▼
┌─────────────────────────────────────┐
│  AI review via Claude Code CLI      │
│  (diff sent, findings returned)     │
│  BLOCK → push blocked               │
│  PASS  → push proceeds              │
└─────────────────────────────────────┘
```

`git push` stays the main entry point. Pushgate plugs into it through the installed `pre-push` hook; `pushgate push` is an optional friendly wrapper for the same workflow.

Local deterministic checks can block a push. Local AI supports `blocking`, `advisory`, and `off` modes; `blocking` is the default, matching the review gate shown above. CI and PR checks remain the final enforcement point for policy that must survive local hook skips.

`.pushgate.yml` is the primary project config. `.push-review.yml` belongs to migration compatibility rather than the public config contract.

## Install

```bash
# Default (base template — no tools pre-configured, fully documented)
curl -fsSL https://raw.githubusercontent.com/rootstrap/ai-pushgate/main/install.sh | bash

# Node.js
curl -fsSL https://raw.githubusercontent.com/rootstrap/ai-pushgate/main/install.sh | bash -s -- --template node

# TypeScript
curl -fsSL https://raw.githubusercontent.com/rootstrap/ai-pushgate/main/install.sh | bash -s -- --template typescript

# Next.js
curl -fsSL https://raw.githubusercontent.com/rootstrap/ai-pushgate/main/install.sh | bash -s -- --template nextjs

# Ruby
curl -fsSL https://raw.githubusercontent.com/rootstrap/ai-pushgate/main/install.sh | bash -s -- --template ruby

# Ruby on Rails
curl -fsSL https://raw.githubusercontent.com/rootstrap/ai-pushgate/main/install.sh | bash -s -- --template rails
```

The installer:

1. Installs the `pushgate` command used by the hook
2. Downloads and validates `hook/pre-push` → `.git/hooks/pre-push`
3. Backs up any existing `pre-push` hook before overwriting
4. Downloads the template config → `.pushgate.yml` (only on first install — never overwrites)
5. Checks configured runtimes and AI dependencies

## Requirements

**Git** is required. Pushgate plugs into its `pre-push` hook path.

**AI providers** depend on the configured mode. For example, Claude feedback requires Claude Code CLI:

```bash
npm install -g @anthropic-ai/claude-code
claude /login
```

**Runtime dependencies** depend on the tools you configure:

| Runtime | Required by |
|---------|-------------|
| Node.js | `node`, `typescript`, `nextjs` templates |
| Ruby    | `ruby`, `rails` templates |
| Python  | Python tools (manual config) |
| Go      | Go tools (manual config) |

The installer checks which runtimes your config requires and warns about any that are missing.

## Configuration

After install, edit `.pushgate.yml` in your project root:

```yaml
version: 2

ai:
  # Supported modes: blocking (default), advisory, off.
  mode: blocking
  provider: claude
  providers:
    claude:
      # Provider-specific settings live below the selected provider block.
      model: claude-sonnet-4-20250514

review:
  target_branch: main       # diff base: git diff <target_branch>...HEAD
  context_lines: 10         # surrounding context lines included in the diff
  max_lines_for_full_file: 300  # below this threshold, full file contents are sent
                                # instead of just the diff for richer context

# Tools to run before AI review — first failure blocks the push immediately
tools:
  - name: eslint
    # Commands are argv arrays. {changed_files} is expanded by the runner.
    command: ["npx", "eslint", "{changed_files}"]
    extensions: [".js", ".jsx", ".ts", ".tsx"]

  - name: brakeman
    command: ["bundle", "exec", "brakeman", "--no-pager", "--quiet"]
    # no {changed_files} → runs on the whole project

# Files and patterns excluded from tool checks and AI review
ignore_paths:
  - "*.lock"
  - "dist/**"
  - "coverage/**"
```

V2 configs must declare `version: 2`. Core config sections are strict, provider-specific config belongs below `ai.providers.<provider>`, and tool commands are argv arrays rather than shell strings. Reviewer focus and default finding-category instructions live with the built-in review prompt rather than the v2 config surface. See `docs/v2-config-schema.md` for the schema boundary and migration behavior for `.push-review.yml`.

## Available templates

| `--template` | Stack | Tools pre-configured |
|---|---|---|
| `base` | Any | None (fully-documented reference config) |
| `node` | Node.js | ESLint, Prettier, Jest |
| `typescript` | TypeScript | tsc, ESLint, Prettier, Jest |
| `nextjs` | Next.js | tsc, next lint, Prettier, Jest |
| `ruby` | Ruby | RuboCop, Reek, RSpec |
| `rails` | Ruby on Rails | RuboCop, Reek, Brakeman, RSpec |

## Skip checks

To bypass the hook for a single push:

```bash
git push --no-verify
```

To keep deterministic checks but skip AI for one push, use Git's temporary config channel:

```bash
git -c pushgate.skip-ai-check=true push
git -c pushgate.skip-all-checks=true push
```

The optional wrapper maps friendly flags to the same one-push config:

```bash
pushgate push --skip-ai-check
pushgate push --skip-all-checks
```

## Updating

Re-run the installer to update the hook script. Your `.pushgate.yml` is **never overwritten** — it stays exactly as you've configured it.

```bash
curl -fsSL https://raw.githubusercontent.com/rootstrap/ai-pushgate/main/install.sh | bash
```

To also reset your config to a template, delete it first:

```bash
rm .pushgate.yml
curl -fsSL https://raw.githubusercontent.com/rootstrap/ai-pushgate/main/install.sh | bash -s -- --template <name>
```

## Contributing

To add a new template:

1. Add `templates/<name>.yml` following the structure of an existing template (e.g. `ruby.yml`)
2. Add a row to the **Available templates** table in this README
3. Open a pull request

Templates should include sensible `ignore_paths` defaults and pre-configured `tools` for the common tools in that stack. The `base.yml` template is the reference for all available config options.

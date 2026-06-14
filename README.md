# ai-pushgate

A language-agnostic push gate for regular git push workflows. An installed pre-push hook delegates into a managed Pushgate runner so local checks and AI review can fit the normal `git push` flow before changes reach the next layer of review.

## Target workflow

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
│  Run configured deterministic checks │
│  (built-in policies, tools)          │
│  ✗ blocking failure → push blocked  │
│  ! warning failure → push proceeds  │
└──────────────┬──────────────────────┘
               │ all pass
               ▼
┌─────────────────────────────────────┐
│  AI review via Claude Code CLI      │
│  (diff sent, normalized findings)   │
│  BLOCK → push blocked               │
│  PASS  → push proceeds              │
└─────────────────────────────────────┘
```

`git push` stays the main entry point. Pushgate plugs into it through the installed `pre-push` hook; `pushgate push` is an optional friendly wrapper for the same workflow.

Local deterministic checks can block a push. Local AI supports `blocking`, `advisory`, and `off` modes; `blocking` is the default, matching the review gate shown above. CI and PR checks remain the final enforcement point for policy that must survive local hook skips.

`.pushgate.yml` is the primary project config. `.push-review.yml` belongs to migration compatibility rather than the public config contract.

The current M1 runner boundary is intentionally thin: the installer wires the
hook to the managed `pushgate` command, the command accepts Git pre-push
context, and policy execution now flows through the changed-file layer,
deterministic checks, and a provider-backed local AI phase. The first adapter
keeps Claude-specific invocation behind the runner's provider boundary so later
providers can reuse the same seam.

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
5. Checks the Node.js runtime required by the managed command

## Requirements

**Git** is required. Pushgate plugs into its `pre-push` hook path.

**Node.js** is required by the installer-managed `pushgate` command.

**AI providers** depend on the configured mode. For example, Claude feedback requires Claude Code CLI:

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

**Configured tool runtimes** depend on the tools you configure:

| Runtime | Required by |
|---------|-------------|
| Node.js | `node`, `typescript`, `nextjs` templates |
| Ruby    | `ruby`, `rails` templates |
| Python  | Python tools (manual config) |
| Go      | Go tools (manual config) |

## Configuration

After install, edit `.pushgate.yml` in your project root:

```yaml
version: 2

ai:
  # Supported modes: blocking (default), advisory, off.
  mode: blocking
  max_changed_lines: 500      # skip AI when changed text lines exceed this
  max_prompt_tokens: 12000    # approximate rendered prompt budget
  timeout_seconds: 120        # provider timeout before mode-specific failure handling
  provider: claude
  providers:
    claude:
      # Provider-specific settings live below the selected provider block.
      model: claude-sonnet-4-20250514

review:
  target_branch: main       # local ref for git diff <target_branch>...HEAD
  context_lines: 10         # surrounding context lines included in the diff
  max_lines_for_full_file: 300  # below this threshold, full file contents are sent
                                # instead of just the diff for richer context

# Tools to run before AI review — first failure blocks the push immediately
tools:
  - name: eslint
    # Commands are argv arrays. {changed_files} is expanded by the runner.
    command: ["npx", "eslint", "{changed_files}"]
    extensions: [".js", ".jsx", ".ts", ".tsx"]
    timeout_seconds: 60  # default command budget
    mode: blocking       # blocking failures stop the push; warning only reports
    run: changed_files   # skip when no matching live changed files exist
    fail_fast: true      # stop later tools after this blocking failure

  - name: brakeman
    command: ["bundle", "exec", "brakeman", "--no-pager", "--quiet"]
    run: always          # no {changed_files} -> runs on the whole project

# Optional built-in policies that do not require external tools
policies:
  diff_size:
    max_changed_lines: 500
    mode: warning        # report large diffs without blocking

  forbidden_paths:
    patterns:
      - ".env"
      - ".env.*"
      - "secrets/**"
      - "*.pem"
    mode: blocking       # block pushes that add or modify matching paths

# Gitignore-like repo-relative paths excluded from tool checks and AI review
ignore_paths:
  - "*.lock"
  - "dist/**"
  - "coverage/**"
```

V2 configs must declare `version: 2`. Core config sections are strict, provider-specific config belongs below `ai.providers.<provider>`, and tool commands are argv arrays rather than shell strings. `{changed_files}` expands to individual argv entries without shell interpolation, so filenames with spaces stay one argument. Built-in policies are opt-in deterministic checks and share the same `blocking`/`warning` behavior as command tools. Local AI guardrails skip only the AI phase with visible output when a change exceeds the changed-line or approximate prompt-token budget; deterministic checks still run first. Reviewer focus and default finding-category instructions live with the built-in review prompt rather than the v2 config surface. Provider adapters now return one normalized JSON review result, including per-finding confidence plus provider source metadata that Pushgate uses for provider-neutral rendering. See `docs/v2-config-schema.md` for the schema boundary, changed-file policy, and migration behavior for `.push-review.yml`.

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

Scoped one-push skip controls are the v2 contract for the runner work that
follows. They use Git's temporary config channel:

```bash
git -c pushgate.skip-ai-check=true push
git -c pushgate.skip-all-checks=true push
```

The planned optional wrapper maps friendly flags to the same one-push config:

```bash
pushgate push --skip-ai-check
pushgate push --skip-all-checks
```

## Updating

Re-run the installer to update the managed command and hook script. Your `.pushgate.yml` is **never overwritten** — it stays exactly as you've configured it.

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

Templates should include sensible `ignore_paths` defaults and pre-configured `tools` for the common tools in that stack. The `base.yml` template is the reference for all available config options, including opt-in built-in policies.

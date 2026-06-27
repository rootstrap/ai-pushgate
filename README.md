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
│  (built-in policies, plugins, tools) │
│  ✗ blocking failure → push blocked  │
│  ! warning failure → confirm first  │
└──────────────┬──────────────────────┘
               │ all pass or warnings confirmed
               ▼
┌─────────────────────────────────────┐
│  AI review via selected provider    │
│  (Claude or GitHub Copilot CLI)     │
│  BLOCK → push blocked               │
│  PASS  → push proceeds              │
└─────────────────────────────────────┘
```

`git push` stays the main entry point. Pushgate plugs into it through the installed `pre-push` hook; `pushgate push` is an optional friendly wrapper for the same workflow.

Local deterministic checks can block a push. Warning results require an explicit yes/no confirmation before the push continues. Local AI supports `blocking`, `advisory`, and `off` modes; `blocking` is the default, matching the review gate shown above. CI and PR checks remain the final enforcement point for policy that must survive local hook skips.

`.pushgate.yml` is the primary project config. `.push-review.yml` belongs to migration compatibility rather than the public config contract.

The current runner boundary is intentionally thin: the installer wires the hook
to the managed `pushgate` command, the command accepts Git pre-push context,
and policy execution now flows through the changed-file layer, deterministic
checks, and a provider-backed local AI phase. Claude and GitHub Copilot
invocation stay behind the runner's provider boundary so future providers can
reuse the same seam.

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

**AI providers** depend on the configured mode.

Claude feedback requires Claude Code CLI:

```bash
npm install -g @anthropic-ai/claude-code
claude
```

Inside Claude, run `/login` in the same user environment that runs `git push`.
Pushgate uses Claude Code safe mode by default so your local login still works
while project-specific Claude customizations stay disabled. If you opt into
`ai.providers.claude.bare: true`, Claude Code skips OAuth/keychain reads and
requires `ANTHROPIC_API_KEY` or an `apiKeyHelper` passed through Claude settings.

GitHub Copilot feedback requires the standalone GitHub Copilot CLI. Authenticate
interactively with `copilot login` or configure one of the supported token
environment variables, such as `COPILOT_GITHUB_TOKEN`, for non-interactive
environments.

**Configured tool runtimes** depend on the tools you configure:

| Runtime | Required by |
|---------|-------------|
| Node.js | `node`, `typescript`, `nextjs` templates |
| Ruby    | `ruby`, `rails` templates |
| Python  | Python tools (manual config) |
| Go      | Go tools (manual config) |
| Gitleaks | `plugins.gitleaks` secret scanning |

## Configuration

After install, edit `.pushgate.yml` in your project root:

```yaml
version: 2

ai:
  # Supported modes: blocking (default), advisory, off.
  mode: blocking
  max_changed_lines: 500      # block push when changed text lines exceed this
  max_prompt_tokens: 12000    # approximate rendered prompt budget
  timeout_seconds: 120        # provider timeout before mode-specific failure handling
  provider: claude
  providers:
    claude:
      # Provider-specific settings live below the selected provider block.
      model: claude-sonnet-4-20250514
      # Optional: use Claude Code --bare for API-key automation.
      # bare: true
    # To use GitHub Copilot CLI instead, set provider: copilot above:
    # copilot:
    #   model: auto

review:
  target_branch: main       # local ref used to resolve changed files
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
    mode: blocking       # blocking failures stop; warning requires confirmation
    run: changed_files   # skip when no matching live changed files exist
    fail_fast: true      # stop later tools after this blocking failure

  - name: brakeman
    command: ["bundle", "exec", "brakeman", "--no-pager", "--quiet"]
    run: always          # no {changed_files} -> runs on the whole project

# Optional built-in policies that do not require external tools
policies:
  diff_size:
    max_changed_lines: 500
    mode: warning        # report large diffs and require confirmation

  forbidden_paths:
    patterns:
      - ".env"
      - ".env.*"
      - "secrets/**"
      - "*.pem"
    mode: blocking       # block pushes that add or modify matching paths

# Optional plugin adapters. Gitleaks scans the branch commit range before
# push, catching secrets that were introduced anywhere in the commits being
# pushed.
plugins:
  gitleaks:
    enabled: true
    command: gitleaks
    timeout_seconds: 60
    mode: blocking
    fail_fast: true
    config_path: .gitleaks.toml          # optional
    baseline_path: .gitleaks/baseline.json # optional
    gitleaks_ignore_path: .gitleaksignore  # optional

# Gitignore-like repo-relative paths excluded from tool checks and AI review
ignore_paths:
  - "*.lock"
  - "dist/**"
  - "coverage/**"
```

V2 configs must declare `version: 2`. Core config sections are strict, provider-specific config belongs below `ai.providers.<provider>`, and tool commands are argv arrays rather than shell strings. `{changed_files}` expands to individual argv entries without shell interpolation, so filenames with spaces stay one argument. Built-in policies are opt-in deterministic checks and share the same `blocking`/`warning` behavior as command tools. Path policy resolves changed files once, then exposes a review range for local AI diff context and a scan range for commit scanners. `plugins.gitleaks` delegates secret scanning to the Gitleaks CLI using that scan range (`<merge-base>..HEAD`) plus a temporary JSON report, while preserving Gitleaks' own config, baseline, and ignore-file mechanisms. Local AI blocks the push when changed text lines exceed `ai.max_changed_lines`, and skips only the AI phase when the approximate prompt-token budget is exceeded; deterministic checks still run first. If deterministic checks or local AI produce warnings, Pushgate asks whether to continue; declining, or running without an interactive terminal for the prompt, blocks the push. Reviewer focus and default finding-category instructions live with the built-in review prompt rather than the v2 config surface. Provider adapters return one normalized JSON review result, including per-finding confidence plus provider source metadata that Pushgate uses for provider-neutral rendering. Pushgate currently supports `claude` and `copilot` provider IDs. See `docs/v2-config-schema.md` for the schema boundary, changed-file policy, and migration behavior for `.push-review.yml`.

AI review output is provider-independent. Pushgate validates every provider response against the same local schema before consuming findings. Providers that support native JSON Schema, strict tool calls, or JSON mode can use stronger generation-time constraints in future adapters; current Claude and Copilot CLI adapters are text fallback providers, so Pushgate prompts them for the schema, safely repairs a small set of low-risk formatting damage, and rejects output that still does not match the contract.

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

The optional wrapper maps friendly flags to the same one-push config:

```bash
pushgate push --skip-ai-check
pushgate push --skip-all-checks
```

## Runner overrides

The installed hook resolves the Pushgate runner in this order:

1. Repository-local `git config pushgate.runner`
2. `PUSHGATE_RUNNER` environment variable
3. Managed install at `~/.pushgate/bin/pushgate`

This makes it possible to test an unpublished runner build in one repository
without replacing the stable managed install for every repository on the
machine.

Routine hook runs keep runner wiring quiet. When diagnosing an override, set
`PUSHGATE_VERBOSE=1` to print the resolved runner source and path, for example:

```text
[pushgate] Using runner from git config pushgate.runner: /absolute/path/to/bin/pushgate.mjs
```

```bash
# Point one repository at a locally built runner
git config --local pushgate.runner /absolute/path/to/bin/pushgate.mjs

# Use normal Git entrypoints while the override is active
git push

# Remove the repository override and fall back to the managed install
git config --unset --local pushgate.runner
```

For one shell session or one command, use `PUSHGATE_RUNNER` instead:

```bash
PUSHGATE_RUNNER=/absolute/path/to/bin/pushgate.mjs PUSHGATE_VERBOSE=1 git push
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

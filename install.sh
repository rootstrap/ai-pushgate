#!/usr/bin/env bash
# =============================================================================
# Pushgate installer
# =============================================================================
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/rootstrap/ai-pushgate/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/rootstrap/ai-pushgate/main/install.sh | bash -s -- --template ruby
#   curl -fsSL https://raw.githubusercontent.com/rootstrap/ai-pushgate/main/install.sh | bash -s -- --template rails
#   curl -fsSL https://raw.githubusercontent.com/rootstrap/ai-pushgate/main/install.sh | bash -s -- --template nextjs
#
# Available templates: base, node, typescript, ruby, rails, nextjs
# =============================================================================

set -euo pipefail

# Colours
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# Output helpers
info()    { echo -e "${CYAN}${BOLD}[pushgate]${RESET} $*"; }
success() { echo -e "${GREEN}${BOLD}[pushgate]${RESET} $*"; }
warn()    { echo -e "${YELLOW}${BOLD}[pushgate]${RESET} Warning: $*"; }
error()   { echo -e "${RED}${BOLD}[pushgate]${RESET} Error: $*" >&2; exit 1; }
divider() { echo -e "${CYAN}----------------------------------------------${RESET}"; }

# Remote assets
REPO_BASE_URL="https://raw.githubusercontent.com/rootstrap/ai-pushgate/main"
HOOK_URL="${REPO_BASE_URL}/hook/pre-push"
RUNNER_URL="${REPO_BASE_URL}/bin/pushgate.mjs"
TEMPLATES_URL="${REPO_BASE_URL}/templates"
TEMPLATE="base"

# Arguments
while [ "$#" -gt 0 ]; do
  case "$1" in
    --template)
      if [ "$#" -lt 2 ]; then
        error "Missing template name. Usage: --template <name>."
      fi
      TEMPLATE=$(echo "$2" | tr '[:upper:]' '[:lower:]')
      shift 2
      ;;
    *)
      error "Unknown argument: $1. Usage: --template <name>. Available: base, node, typescript, ruby, rails, nextjs"
      ;;
  esac
done

TEMPLATE_URL="${TEMPLATES_URL}/${TEMPLATE}.yml"

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  error "Not inside a git repository. Run this from the root of your project."
fi

if [ -z "${HOME:-}" ]; then
  error "HOME must be set so Pushgate can install its managed command."
fi

if ! command -v curl >/dev/null 2>&1; then
  error "curl is required but not found."
fi

if ! command -v node >/dev/null 2>&1; then
  error "Node.js is required by the Pushgate command but was not found."
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
HOOKS_DIR="$REPO_ROOT/.git/hooks"
HOOK_DEST="$HOOKS_DIR/pre-push"
CONFIG_DEST="$REPO_ROOT/.pushgate.yml"
RUNNER_DIR="$HOME/.pushgate/bin"
RUNNER_DEST="$RUNNER_DIR/pushgate"

TMP_DIR=$(mktemp -d)
RUNNER_TMP="$TMP_DIR/pushgate.mjs"
HOOK_TMP="$TMP_DIR/pre-push"
CONFIG_TMP="$TMP_DIR/template.yml"
trap 'rm -rf "$TMP_DIR"' EXIT

divider
info "Installing Pushgate..."
echo -e "  Template: ${BOLD}${TEMPLATE}${RESET}"
divider

# Install the managed command used by the thin hook.
info "Downloading Pushgate command..."
if ! curl -fsSL "$RUNNER_URL" -o "$RUNNER_TMP"; then
  error "Failed to download Pushgate command from ${RUNNER_URL}."
fi

if ! head -1 "$RUNNER_TMP" | grep -q 'node'; then
  error "Downloaded Pushgate command does not appear to be a Node entrypoint."
fi

if ! node --check "$RUNNER_TMP" >/dev/null; then
  error "Downloaded Pushgate command has a syntax error."
fi

mkdir -p "$RUNNER_DIR"
cp "$RUNNER_TMP" "$RUNNER_DEST"
chmod +x "$RUNNER_DEST"
success "Command installed at ${RUNNER_DEST}."

# Install the hook into the current repository.
info "Downloading pre-push hook..."
if ! curl -fsSL "$HOOK_URL" -o "$HOOK_TMP"; then
  error "Failed to download pre-push hook from ${HOOK_URL}."
fi

if ! head -1 "$HOOK_TMP" | grep -q 'bash'; then
  error "Downloaded hook does not appear to be a Bash script."
fi

if ! bash -n "$HOOK_TMP"; then
  error "Downloaded hook has a syntax error. Please report this at https://github.com/rootstrap/ai-pushgate."
fi

HOOK_VERSION=$(grep 'HOOK_VERSION=' "$HOOK_TMP" | head -1 | sed 's/.*HOOK_VERSION="\([^"]*\)".*/\1/')

mkdir -p "$HOOKS_DIR"
if [ -f "$HOOK_DEST" ]; then
  BACKUP="${HOOK_DEST}.backup.$(date +%Y%m%d%H%M%S)"
  warn "Existing pre-push hook found. Backing up to ${BACKUP}."
  cp "$HOOK_DEST" "$BACKUP"
fi

cp "$HOOK_TMP" "$HOOK_DEST"
chmod +x "$HOOK_DEST"
success "Hook installed (v${HOOK_VERSION})."

# Install the v2 config only when the repository does not have one yet.
if [ -f "$CONFIG_DEST" ]; then
  warn ".pushgate.yml already exists. Skipping config download."
  warn "To reset to the ${TEMPLATE} template, delete .pushgate.yml and re-run."
else
  info "Downloading ${TEMPLATE} config template..."
  if ! curl -fsSL "$TEMPLATE_URL" -o "$CONFIG_TMP"; then
    error "Failed to download template '${TEMPLATE}' from ${TEMPLATE_URL}."
  fi

  cp "$CONFIG_TMP" "$CONFIG_DEST"
  success "Config written to .pushgate.yml."
fi

divider
NODE_VERSION=$(node --version 2>/dev/null || echo "unknown")
success "Node.js found (${NODE_VERSION})."
divider
echo -e "${GREEN}${BOLD}  Pushgate v${HOOK_VERSION} installed successfully.${RESET}"
divider
echo ""
echo -e "  Edit ${BOLD}.pushgate.yml${RESET} to configure Pushgate for this repository."
echo -e "  The installed hook uses ${BOLD}${RUNNER_DEST}${RESET}."
echo ""

#!/usr/bin/env bash
# GenFire CLI installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/genfireai/cli/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/genfireai/cli/main/install.sh | sh -s -- --version 0.2.0

set -euo pipefail

REPO="genfireai/cli"
PACKAGE="@genfire/cli"
REQUESTED_VERSION="${GENFIRE_INSTALL_VERSION:-latest}"
SKIP_NODE_INSTALL="${GENFIRE_SKIP_NODE:-0}"

# --- arg parsing -------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      REQUESTED_VERSION="$2"; shift 2 ;;
    --version=*)
      REQUESTED_VERSION="${1#*=}"; shift ;;
    --skip-node)
      SKIP_NODE_INSTALL=1; shift ;;
    -h|--help)
      cat <<EOF
GenFire CLI installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/genfireai/cli/main/install.sh | sh
  curl -fsSL https://raw.githubusercontent.com/genfireai/cli/main/install.sh | sh -s -- --version 0.2.0
  curl -fsSL https://raw.githubusercontent.com/genfireai/cli/main/install.sh | sh -s -- --skip-node

Options:
  --version <X.Y.Z>    Install a specific version (default: latest)
  --skip-node          Don't try to install Node — fail if missing
  -h, --help           Show this help

After install:
  genfire auth login
  genfire
EOF
      exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Run with --help for usage." >&2
      exit 1 ;;
  esac
done

# --- helpers -----------------------------------------------------------------
say() { printf '%s\n' "$*"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$*" >&2; }
err() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
ok() { printf '\033[32m✓\033[0m %s\n' "$*"; }

have() { command -v "$1" >/dev/null 2>&1; }

NODE_MAJOR_REQUIRED=20

check_node() {
  if have node; then
    local current
    current=$(node --version | sed 's/^v//' | cut -d. -f1)
    if [ "$current" -ge "$NODE_MAJOR_REQUIRED" ]; then
      ok "Node $(node --version) detected"
      return 0
    fi
    warn "Node $(node --version) is below required v${NODE_MAJOR_REQUIRED}.0.0"
    return 1
  fi
  return 1
}

install_node_via_homebrew() {
  if ! have brew; then return 1; fi
  say "Installing Node ${NODE_MAJOR_REQUIRED} via Homebrew..."
  brew install "node@${NODE_MAJOR_REQUIRED}" >/dev/null
  brew link --overwrite --force "node@${NODE_MAJOR_REQUIRED}" 2>/dev/null || true
  check_node
}

install_node_via_nvm() {
  if [ ! -d "$HOME/.nvm" ]; then
    say "Installing nvm (Node Version Manager)..."
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash >/dev/null
  fi
  # shellcheck disable=SC1091
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  if ! have nvm; then return 1; fi
  say "Installing Node ${NODE_MAJOR_REQUIRED} via nvm..."
  nvm install "$NODE_MAJOR_REQUIRED" >/dev/null
  nvm alias default "$NODE_MAJOR_REQUIRED" >/dev/null
  check_node
}

install_node() {
  if [ "$SKIP_NODE_INSTALL" = "1" ]; then
    err "Node ${NODE_MAJOR_REQUIRED}+ is required but --skip-node was passed."
  fi

  case "$(uname -s)" in
    Darwin)
      install_node_via_homebrew && return 0
      install_node_via_nvm && return 0
      ;;
    Linux)
      install_node_via_nvm && return 0
      ;;
  esac

  err "Could not install Node automatically. Install Node ${NODE_MAJOR_REQUIRED}+ from https://nodejs.org and re-run this script."
}

install_cli() {
  local target="$PACKAGE"
  if [ "$REQUESTED_VERSION" != "latest" ]; then
    target="${PACKAGE}@${REQUESTED_VERSION}"
  fi

  say "Installing ${target}..."
  if npm install -g "$target" 2>/tmp/genfire-install.log; then
    return 0
  fi

  # If global install failed with EACCES, try with sudo (interactive only).
  if grep -q "EACCES" /tmp/genfire-install.log 2>/dev/null; then
    if [ -t 0 ] && have sudo; then
      warn "npm reported a permission error. Retrying with sudo..."
      sudo npm install -g "$target"
      return 0
    fi
    err "npm install failed with permission denied. Configure a user-owned npm prefix (https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally) and retry."
  fi

  cat /tmp/genfire-install.log >&2
  err "npm install failed. Output above."
}

verify_path() {
  if have genfire; then
    ok "genfire installed at $(command -v genfire)"
    return 0
  fi

  local prefix bin_dir
  prefix=$(npm config get prefix 2>/dev/null || echo "")
  if [ -n "$prefix" ] && [ -x "$prefix/bin/genfire" ]; then
    bin_dir="$prefix/bin"
    warn "genfire was installed to $bin_dir but it's not on your PATH."
    say ""
    say "Add this to your shell config (e.g. ~/.zshrc or ~/.bashrc):"
    say "  export PATH=\"$bin_dir:\$PATH\""
    say ""
    say "Then reload: source ~/.zshrc"
    return 0
  fi

  err "genfire was installed but couldn't be located. Try opening a new terminal."
}

# --- run ---------------------------------------------------------------------
say ""
say "  Installing the GenFire CLI"
say "  ────────────────────────────"
say ""

if ! check_node; then
  install_node
fi

if ! have npm; then
  err "Node is installed but npm is missing. Reinstall Node from https://nodejs.org."
fi

install_cli
verify_path

say ""
ok "Installed @genfire/cli"
say ""
say "Next steps:"
say "  1. genfire auth login     — authenticate via your browser"
say "  2. genfire                — drop into the interactive shell"
say "  3. genfire generate image \"a neon-lit alley\" -o alley.png"
say ""
say "Docs: https://github.com/${REPO}#readme"
say ""

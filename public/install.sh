#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  ShareSecure — One-Line Self-Hosted Installer
#  Supports: macOS, Ubuntu/Debian, Fedora/RHEL, Arch
#  Usage:  curl -fsSL https://raw.githubusercontent.com/ishaanman7898/ShareSecure/main/public/install.sh | bash
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── config (override via env vars) ──────────────────────────────────────────
REPO_URL="${SHARESECURE_REPO:-https://github.com/ishaanman7898/ShareSecure}"
INSTALL_DIR="${SHARESECURE_DIR:-$HOME/sharesecure}"
PORT="${SHARESECURE_PORT:-3000}"
MIN_NODE=18

# ── colours ──────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD="\033[1m"; RESET="\033[0m"
  BLUE="\033[34m"; GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"; DIM="\033[2m"
else
  BOLD=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""; DIM=""
fi

header() { echo -e "\n${BLUE}${BOLD}▶  $*${RESET}"; }
ok()     { echo -e "  ${GREEN}✓${RESET}  $*"; }
warn()   { echo -e "  ${YELLOW}!${RESET}  $*"; }
err()    { echo -e "  ${RED}✗${RESET}  $*" >&2; exit 1; }
step()   { echo -e "  ${DIM}$*${RESET}"; }

echo ""
echo -e "${BLUE}${BOLD}╔══════════════════════════════════════╗${RESET}"
echo -e "${BLUE}${BOLD}║    ShareSecure  ·  Self-Host Setup   ║${RESET}"
echo -e "${BLUE}${BOLD}╚══════════════════════════════════════╝${RESET}"
echo ""

# ── detect OS ────────────────────────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="mac" ;;
  Linux)
    if   [ -f /etc/debian_version ]; then PLATFORM="debian"
    elif [ -f /etc/fedora-release  ]; then PLATFORM="fedora"
    elif [ -f /etc/arch-release    ]; then PLATFORM="arch"
    else PLATFORM="linux"
    fi ;;
  *) err "Unsupported OS: $OS. Use the Docker method instead." ;;
esac
ok "Detected platform: $OS ($PLATFORM)"

# ── check / install Node.js ───────────────────────────────────────────────────
header "Checking Node.js (required >= $MIN_NODE)"

install_node_nvm() {
  step "Installing Node.js via nvm..."
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  # shellcheck disable=SC1090
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install --lts
  nvm use --lts
  ok "Node.js $(node -v) installed via nvm"
}

if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  if [ "$NODE_MAJOR" -lt "$MIN_NODE" ]; then
    warn "Node.js $NODE_VER is too old (need >= $MIN_NODE). Upgrading via nvm..."
    install_node_nvm
  else
    ok "Node.js v$NODE_VER"
  fi
else
  warn "Node.js not found. Installing..."
  case "$PLATFORM" in
    mac)
      if command -v brew &>/dev/null; then
        step "Using Homebrew..."
        brew install node@20
        brew link --overwrite node@20
        ok "Node.js $(node -v) installed via Homebrew"
      else
        install_node_nvm
      fi ;;
    debian)
      step "Using apt..."
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
      sudo apt-get install -y nodejs
      ok "Node.js $(node -v) installed" ;;
    fedora)
      step "Using dnf..."
      sudo dnf install -y nodejs npm
      ok "Node.js $(node -v) installed" ;;
    arch)
      step "Using pacman..."
      sudo pacman -Sy --noconfirm nodejs npm
      ok "Node.js $(node -v) installed" ;;
    *)
      install_node_nvm ;;
  esac
fi

# ── check for git or curl/wget ────────────────────────────────────────────────
header "Downloading ShareSecure"

if [ -d "$INSTALL_DIR/.git" ]; then
  step "Existing installation found — pulling latest..."
  git -C "$INSTALL_DIR" pull --ff-only
  ok "Updated to latest version"
elif command -v git &>/dev/null; then
  step "Cloning from $REPO_URL..."
  git clone --depth=1 "$REPO_URL" "$INSTALL_DIR"
  ok "Downloaded to $INSTALL_DIR"
else
  # fallback: download zip
  ZIP_URL="${REPO_URL}/archive/refs/heads/main.zip"
  TMP_ZIP=$(mktemp /tmp/sharesecure-XXXXXX.zip)
  step "git not found — downloading zip from $ZIP_URL..."
  if command -v curl &>/dev/null; then
    curl -fsSL "$ZIP_URL" -o "$TMP_ZIP"
  elif command -v wget &>/dev/null; then
    wget -q "$ZIP_URL" -O "$TMP_ZIP"
  else
    err "Neither git, curl, nor wget found. Please install one and retry."
  fi
  mkdir -p "$INSTALL_DIR"
  UNZIP_DIR=$(mktemp -d /tmp/sharesecure-extract-XXXXXX)
  unzip -q "$TMP_ZIP" -d "$UNZIP_DIR"
  # GitHub zip contains a top-level folder
  INNER=$(ls "$UNZIP_DIR")
  cp -r "$UNZIP_DIR/$INNER/." "$INSTALL_DIR/"
  rm -rf "$TMP_ZIP" "$UNZIP_DIR"
  ok "Downloaded and extracted to $INSTALL_DIR"
fi

# ── npm install ───────────────────────────────────────────────────────────────
header "Installing dependencies"
cd "$INSTALL_DIR"
npm install --omit=dev --silent
ok "Dependencies installed"

# ── configure .env ────────────────────────────────────────────────────────────
header "Configuring environment"

if [ ! -f "$INSTALL_DIR/.env" ]; then
  ENC_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  {
    echo "PORT=$PORT"
    echo "BASE_URL=http://localhost:$PORT"
    echo "ENCRYPTION_KEY=$ENC_KEY"
    echo "DATA_DIR=$INSTALL_DIR/data"
  } > "$INSTALL_DIR/.env"
  ok ".env created with a fresh AES-256 encryption key"
else
  ok ".env already exists — skipping (delete it to reset)"
fi

# ── create data directories ───────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR/data/uploads"
ok "Data directory ready at $INSTALL_DIR/data"

# ── done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════╗${RESET}"
echo -e "${GREEN}${BOLD}║   ShareSecure is ready to launch!    ║${RESET}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${BOLD}Start:${RESET}   cd $INSTALL_DIR && npm start"
echo -e "  ${BOLD}Open:${RESET}    http://localhost:$PORT"
echo ""
echo -e "  ${DIM}Your files are stored in $INSTALL_DIR/data/${RESET}"
echo -e "  ${DIM}Edit .env to change the port, base URL, or encryption key.${RESET}"
echo ""

# auto-start if running interactively
if [ -t 1 ]; then
  read -rp "  Start ShareSecure now? [Y/n] " yn
  case "${yn:-Y}" in
    [Yy]*|"")
      echo ""
      npm --prefix "$INSTALL_DIR" start
      ;;
  esac
fi

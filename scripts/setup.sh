#!/usr/bin/env bash
set -euo pipefail

# ── JARVIS Setup ───────────────────────────────────────────────────────────
# Checks prerequisites, creates the Hermes jarvis profile, copies SOUL.md
# and plugins, and bootstraps the .env with generated secrets.
#
# Usage: bash scripts/setup.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

step()  { echo -e "\n${BOLD}==>${RESET} $*"; }
ok()    { echo -e "  ${GREEN}✓${RESET} $*"; }
warn()  { echo -e "  ${YELLOW}⚠${RESET} $*"; }
err()   { echo -e "  ${RED}✗${RESET} $*"; }

# ── 1. Prerequisites ──────────────────────────────────────────────────────

step "Checking prerequisites"

fail=0

if ! command -v node &>/dev/null; then
  err "node not found — install Node.js 20+"
  fail=1
else
  ok "node $(node --version)"
fi

if ! command -v pnpm &>/dev/null; then
  err "pnpm not found — run: npm install -g pnpm"
  fail=1
else
  ok "pnpm $(pnpm --version)"
fi

if ! command -v hermes &>/dev/null; then
  err "hermes not found — install Hermes Agent first: https://github.com/nousresearch/hermes"
  fail=1
else
  ok "hermes $(hermes version 2>/dev/null || echo 'installed')"
fi

HERMES_PYTHON="$HOME/.hermes/hermes-agent/venv/bin/python3"
if [[ ! -x "$HERMES_PYTHON" ]]; then
  err "hermes venv python not found at $HERMES_PYTHON"
  fail=1
else
  ok "hermes venv python ready"
fi

if [[ $fail -ne 0 ]]; then
  echo ""
  exit 1
fi

# ── 2. .env file ──────────────────────────────────────────────────────────

step "Bootstrapping .env files"

ENV_ROOT="$PROJECT_DIR/.env"
ENV_BFF="$PROJECT_DIR/packages/bff/.env"

if [[ ! -f "$ENV_ROOT" ]]; then
  cp "$PROJECT_DIR/.env.example" "$ENV_ROOT"
  ok ".env created from .env.example"
else
  ok ".env already exists"
fi

# Generate JWT_SECRET if empty
if ! grep -q '^JWT_SECRET=.' "$ENV_ROOT" 2>/dev/null; then
  SECRET=$(openssl rand -hex 32)
  if grep -q '^JWT_SECRET=' "$ENV_ROOT"; then
    sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$SECRET/" "$ENV_ROOT"
  else
    echo "JWT_SECRET=$SECRET" >> "$ENV_ROOT"
  fi
  ok "JWT_SECRET generated"
else
  ok "JWT_SECRET already set"
fi

# Copy to bff/.env if it doesn't exist
if [[ ! -f "$ENV_BFF" ]]; then
  cp "$ENV_ROOT" "$ENV_BFF"
  ok "packages/bff/.env created from root .env"
else
  ok "packages/bff/.env already exists"
fi

# ── 3. Hermes jarvis profile ──────────────────────────────────────────────

step "Setting up Hermes 'jarvis' profile"

JARVIS_HOME="$HOME/.hermes/profiles/jarvis"

if [[ -d "$JARVIS_HOME" ]] && [[ -f "$JARVIS_HOME/profile.yaml" ]]; then
  ok "jarvis profile already exists"
else
  hermes profile create jarvis --description "JARVIS voice assistant" --no-alias
  ok "jarvis profile created"
fi

# Copy SOUL.md
cp "$PROJECT_DIR/SOUL.md" "$JARVIS_HOME/SOUL.md"
ok "SOUL.md copied to jarvis profile"

# Copy and enable jarvis plugin
PLUGIN_SRC="$PROJECT_DIR/.hermes/plugins/jarvis"
PLUGIN_DST="$JARVIS_HOME/plugins/jarvis"
mkdir -p "$(dirname "$PLUGIN_DST")"
rm -rf "$PLUGIN_DST"
cp -r "$PLUGIN_SRC" "$PLUGIN_DST"
hermes -p jarvis plugins enable jarvis 2>/dev/null || true
ok "jarvis plugin copied and enabled"

# Copy profile template files (.env defaults, profile.yaml)
PROFILE_TEMPLATE="$PROJECT_DIR/.hermes/profile"
if [[ -d "$PROFILE_TEMPLATE" ]]; then
  cp "$PROFILE_TEMPLATE/.env" "$JARVIS_HOME/.env"
  ok "profile .env copied (defaults: HERMES_YOLO_MODE etc.)"
  cp "$PROFILE_TEMPLATE/profile.yaml" "$JARVIS_HOME/profile.yaml"
  ok "profile.yaml copied"
fi

# ── 3b. Hermes API server platform ────────────────────────────────────────
# Patch the jarvis profile's config.yaml to enable the `api_server`
# platform (the HTTP+SSE surface the BFF talks to). The script also
# generates / reuses a 32-byte hex key in .env as HERMES_API_KEY.
step "Patching Hermes profile for API server (api_server platform)"

if node "$PROJECT_DIR/scripts/hermes-api-server-patch.mjs"; then
  if grep -q "^HERMES_API_KEY=." "$ENV_ROOT"; then
    ok "HERMES_API_KEY set in $ENV_ROOT"
  else
    warn "HERMES_API_KEY missing from $ENV_ROOT — check patch output"
  fi
  if [[ -f "$JARVIS_HOME/config.yaml" ]] && grep -q "api_server:" "$JARVIS_HOME/config.yaml"; then
    ok "platforms.api_server block present in $JARVIS_HOME/config.yaml"
  else
    warn "platforms.api_server block NOT found in $JARVIS_HOME/config.yaml"
  fi
else
  err "hermes-api-server-patch failed (exit $?)"
  exit 1
fi

# ── 4. Dependencies ───────────────────────────────────────────────────────

step "Installing npm dependencies"
cd "$PROJECT_DIR"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
ok "dependencies installed"

# ── Done ──────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${GREEN}${BOLD}  JARVIS base setup complete!${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "${BOLD}Next steps:${RESET}"
echo ""
echo -e "  1. ${BOLD}Set your login password:${RESET}"
echo "     pnpm hash-password \"your-password\""
echo "     Copy the hash to JARVIS_PASSWORD in .env"
echo ""
echo -e "  2. ${BOLD}Set your Deepgram API key:${RESET}"
echo "     Sign up at https://console.deepgram.com"
echo "     Add to .env: DEEPGRAM_API_KEY=<your-key>"
echo ""
echo -e "  3. ${BOLD}Configure the jarvis profile:${RESET}"
echo "     hermes -p jarvis setup"
echo "     (This configures the AI model provider and API key)"
echo ""
echo -e "  4. ${BOLD}Start the app:${RESET}"
echo "     pnpm dev"
echo ""
echo -e "  Open ${BOLD}http://localhost:5174${RESET} and log in."
echo ""

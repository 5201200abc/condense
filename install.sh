#!/usr/bin/env sh
set -e

# condense installer: npm global CLI, then optional local GGUF staging.
# Usage: curl -fsSL https://raw.githubusercontent.com/5201200abc/condense/main/install.sh | sh

REPO="5201200abc/condense"
INSTALL_DIR="${CONDENSE_INSTALL_DIR:-$HOME/.local/bin}"
BINARY_NAME="condense"

# Detect OS
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
  darwin)
    PLATFORM_OS="darwin"
    ;;
  linux)
    PLATFORM_OS="linux"
    ;;
  *)
    echo "[condense] Unsupported operating system: $OS."
    exit 1
    ;;
esac

# Detect Architecture
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)
    PLATFORM_ARCH="x64"
    ;;
  arm64|aarch64)
    PLATFORM_ARCH="arm64"
    ;;
  *)
    echo "[condense] Unsupported CPU architecture: $ARCH."
    exit 1
    ;;
esac

TARGET="${PLATFORM_OS}-${PLATFORM_ARCH}"
PACKAGE_NAME="condense-${TARGET}"

echo "[condense] Detected platform: ${TARGET}"

mkdir -p "$INSTALL_DIR"
TARGET_FILE="$INSTALL_DIR/$BINARY_NAME"
INSTALLED_BIN=""

npm_condense_is_ours() {
  command -v npm >/dev/null 2>&1 || return 1
  url="$(npm view condense repository.url 2>/dev/null || true)"
  [ -n "$url" ] && printf '%s' "$url" | grep -q '5201200abc/condense'
}

if npm_condense_is_ours; then
  echo "[condense] Installing CLI from npm (condense@$(npm view condense version 2>/dev/null || echo latest))..."
  npm install -g "condense@${CONDENSE_VERSION:-latest}"
  INSTALLED_BIN="$(command -v condense || true)"
else
  if command -v npm >/dev/null 2>&1; then
    echo "[condense] Public npm package condense is not this project; skipping npm install -g."
  fi
fi

if [ -z "$INSTALLED_BIN" ]; then
  DOWNLOAD_SUCCESS=0
  if [ -f "./.dist/bun-${TARGET}/condense" ]; then
    cp "./.dist/bun-${TARGET}/condense" "$TARGET_FILE"
    chmod +x "$TARGET_FILE"
    DOWNLOAD_SUCCESS=1
  elif [ -f "./packages/${PACKAGE_NAME}/bin/condense" ]; then
    cp "./packages/${PACKAGE_NAME}/bin/condense" "$TARGET_FILE"
    chmod +x "$TARGET_FILE"
    DOWNLOAD_SUCCESS=1
  elif [ -f "./src/cli.ts" ] && command -v bun >/dev/null 2>&1; then
    echo "[condense] Compiling standalone binary via bun..."
    bun build --compile "--target=bun-${TARGET}" "--outfile=$TARGET_FILE" ./src/cli.ts
    chmod +x "$TARGET_FILE"
    DOWNLOAD_SUCCESS=1
  fi

  if [ "$DOWNLOAD_SUCCESS" -ne 1 ]; then
    echo "[condense] Error: CLI is not on npm for this project yet, and no local binary was found."
    echo "  Install Node, then after CI publishes: npm install -g condense"
    echo "  Or build from a checkout: bun run scripts/build-binaries.ts"
    exit 1
  fi
  INSTALLED_BIN="$TARGET_FILE"
fi

if [ -f "./skills/condense/SKILL.md" ]; then
  SKILL_DEST="${XDG_CONFIG_HOME:-$HOME/.config}/condense/skills/condense"
  mkdir -p "$SKILL_DEST"
  cp -R ./skills/condense/. "$SKILL_DEST/"
fi

echo "[condense] Successfully installed condense ($INSTALLED_BIN)"

prefetch_local_model() {
  GGUF_NAME="condense-0.8B-Q4_K_M.gguf"
  SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)" 2>/dev/null || SCRIPT_DIR=""
  SRC_GGUF=""
  for candidate in \
    "${CONDENSE_LLAMA_GGUF:-}" \
    "$SCRIPT_DIR/training/gguf/v2/$GGUF_NAME" \
    "$(pwd)/training/gguf/v2/$GGUF_NAME"
  do
    if [ -n "$candidate" ] && [ -f "$candidate" ]; then
      SRC_GGUF="$candidate"
      break
    fi
  done
  MODEL_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/condense/models"
  DEST="$MODEL_DIR/$GGUF_NAME"
  if [ -n "$SRC_GGUF" ]; then
    echo "[condense] Installing local v2 Q4 GGUF (~505 MB)..."
    mkdir -p "$MODEL_DIR"
    cp "$SRC_GGUF" "$DEST"
    return 0
  fi
  if [ -s "$DEST" ]; then
    echo "[condense] Using cached $DEST"
    return 0
  fi
  echo "[condense] No packaged $GGUF_NAME found."
  echo "  Place it at $DEST or set CONDENSE_LLAMA_GGUF."
  return 1
}

if [ "${CONDENSE_SKIP_WARMUP:-}" != "1" ]; then
  echo "[condense] Staging local v2 Q4 GGUF..."
  if prefetch_local_model; then
    echo "[condense] Local model weights cached."
  else
    echo "[condense] Warning: v2 GGUF was not staged. llama.cpp will look at CONDENSE_LLAMA_GGUF, training/gguf/v2, or ~/.config/condense/models."
  fi
  if "$INSTALLED_BIN" --help 2>/dev/null | grep -q "condense warmup"; then
    if "$INSTALLED_BIN" warmup; then
      echo "[condense] Local model ready."
    else
      echo "[condense] Warning: could not start the local model server now."
      echo "  It will load on first use: cmd 2>&1 | condense \"question\""
    fi
  else
    echo "[condense] Local runtime will start on first use: cmd 2>&1 | condense \"question\""
  fi
fi

if [ "$INSTALLED_BIN" = "$TARGET_FILE" ]; then
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
      echo ""
      echo "[condense] Notice: $INSTALL_DIR is not in your PATH."
      echo "  Add it by running:"
      echo "    export PATH=\"$INSTALL_DIR:\$PATH\""
      echo "  Or add the line above to your ~/.zshrc or ~/.bashrc"
      echo ""
      ;;
  esac
fi

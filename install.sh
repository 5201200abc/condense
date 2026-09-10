#!/usr/bin/env sh
set -e

# condense universal installer for macOS & Linux
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

# Determine target binary directory
mkdir -p "$INSTALL_DIR"
TARGET_FILE="$INSTALL_DIR/$BINARY_NAME"

# Fetch latest version from GitHub releases
VERSION="${CONDENSE_VERSION:-}"
if [ -z "$VERSION" ]; then
  VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null | grep -o '"tag_name": *"[^"]*"' | head -n 1 | cut -d'"' -f4 | sed 's/^v//' || echo "")
fi

if [ -n "$VERSION" ]; then
  echo "[condense] Installing condense v${VERSION} to ${TARGET_FILE}..."
else
  echo "[condense] GitHub release version unavailable; trying local binaries..."
fi

DOWNLOAD_SUCCESS=0
TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'condense-install')

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# 1. Try GitHub Releases standalone binary asset
if [ -n "$VERSION" ]; then
  GITHUB_RELEASE_URL="https://github.com/${REPO}/releases/download/v${VERSION}/condense-${TARGET}"
  if curl -fsSL "$GITHUB_RELEASE_URL" -o "$TARGET_FILE" 2>/dev/null && [ -s "$TARGET_FILE" ]; then
    chmod +x "$TARGET_FILE"
    DOWNLOAD_SUCCESS=1
  fi
fi

# 2. Try GitHub Releases tarball
if [ "$DOWNLOAD_SUCCESS" -ne 1 ] && [ -n "$VERSION" ]; then
  GITHUB_TARBALL_URL="https://github.com/${REPO}/releases/download/v${VERSION}/condense-${TARGET}.tar.gz"
  if curl -fsSL "$GITHUB_TARBALL_URL" -o "$TMP_DIR/release.tar.gz" 2>/dev/null && [ -s "$TMP_DIR/release.tar.gz" ]; then
    if tar -xzf "$TMP_DIR/release.tar.gz" -C "$TMP_DIR" 2>/dev/null; then
      if [ -f "$TMP_DIR/$BINARY_NAME" ]; then
        cp "$TMP_DIR/$BINARY_NAME" "$TARGET_FILE"
        chmod +x "$TARGET_FILE"
        DOWNLOAD_SUCCESS=1
      fi
    fi
  fi
fi

# 3. Try locally built binary in workspace if available
if [ "$DOWNLOAD_SUCCESS" -ne 1 ]; then
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
fi

if [ "$DOWNLOAD_SUCCESS" -ne 1 ]; then
  echo "[condense] Error: Could not download prebuilt binary for ${TARGET}."
  if [ -z "$VERSION" ]; then
    echo "  GitHub releases/latest did not return a version. Set CONDENSE_VERSION or build from source."
  fi
  echo "  Please check your network connection or build from source via: bun run scripts/build-binaries.ts"
  exit 1
fi

if [ -f "./skills/condense/SKILL.md" ]; then
  SKILL_DEST="${XDG_CONFIG_HOME:-$HOME/.config}/condense/skills/condense"
  mkdir -p "$SKILL_DEST"
  cp -R ./skills/condense/. "$SKILL_DEST/"
fi

echo "[condense] Successfully installed condense to $TARGET_FILE"

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
  if [ -n "${VERSION:-}" ]; then
    mkdir -p "$MODEL_DIR"
    URL="https://github.com/${REPO}/releases/download/v${VERSION}/${GGUF_NAME}"
    echo "[condense] Downloading $GGUF_NAME from GitHub release v${VERSION}..."
    AUTH_HEADER=""
    if [ -n "${GITHUB_TOKEN:-}" ]; then
      AUTH_HEADER="Authorization: Bearer ${GITHUB_TOKEN}"
    elif [ -n "${GH_TOKEN:-}" ]; then
      AUTH_HEADER="Authorization: Bearer ${GH_TOKEN}"
    fi
    if [ -n "$AUTH_HEADER" ]; then
      curl -fL --retry 3 --progress-bar -H "$AUTH_HEADER" "$URL" -o "$DEST"
    else
      curl -fL --retry 3 --progress-bar "$URL" -o "$DEST"
    fi && [ -s "$DEST" ] && return 0
    rm -f "$DEST"
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
  if "$TARGET_FILE" --help 2>/dev/null | grep -q "condense warmup"; then
    if "$TARGET_FILE" warmup; then
      echo "[condense] Local model ready."
    else
      echo "[condense] Warning: could not start the local model server now."
      echo "  It will load on first use: cmd 2>&1 | condense \"question\""
    fi
  else
    echo "[condense] Local runtime will start on first use: cmd 2>&1 | condense \"question\""
  fi
fi

# Check PATH
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

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

if [ -z "$VERSION" ]; then
  VERSION="1.5.2"
fi

echo "[condense] Installing condense v${VERSION} to ${TARGET_FILE}..."

DOWNLOAD_SUCCESS=0
TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'condense-install')

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# 1. Try GitHub Releases standalone binary asset
GITHUB_RELEASE_URL="https://github.com/${REPO}/releases/download/v${VERSION}/condense-${TARGET}"
if curl -fsSL "$GITHUB_RELEASE_URL" -o "$TARGET_FILE" 2>/dev/null && [ -s "$TARGET_FILE" ]; then
  chmod +x "$TARGET_FILE"
  DOWNLOAD_SUCCESS=1
fi

# 2. Try GitHub Releases tarball
if [ "$DOWNLOAD_SUCCESS" -ne 1 ]; then
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
  echo "  Please check your network connection or build from source via: bun run scripts/build-binaries.ts"
  exit 1
fi

echo "[condense] Successfully installed condense to $TARGET_FILE"

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

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

hf_hub_cache() {
  if [ -n "${HUGGINGFACE_HUB_CACHE:-}" ]; then
    printf '%s\n' "$HUGGINGFACE_HUB_CACHE"
    return
  fi
  if [ -n "${HF_HUB_CACHE:-}" ]; then
    printf '%s\n' "$HF_HUB_CACHE"
    return
  fi
  if [ -n "${HF_HOME:-}" ]; then
    printf '%s\n' "$HF_HOME/hub"
    return
  fi
  if [ -n "${XDG_CACHE_HOME:-}" ]; then
    printf '%s\n' "$XDG_CACHE_HOME/huggingface/hub"
    return
  fi
  printf '%s\n' "$HOME/.cache/huggingface/hub"
}

prefetch_hf_repo() {
  repo="$1"
  shift
  if command -v hf >/dev/null 2>&1; then
    hf download "$repo" "$@" && return 0
  fi
  if command -v huggingface-cli >/dev/null 2>&1; then
    huggingface-cli download "$repo" "$@" && return 0
  fi
  if command -v uv >/dev/null 2>&1; then
    uvx --from huggingface_hub hf download "$repo" "$@" && return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    CONDENSE_HF_REPO="$repo" CONDENSE_HF_FILES="$*" python3 - <<'PY' && return 0
import os, sys
try:
    from huggingface_hub import snapshot_download
except ImportError:
    sys.exit(2)
repo = os.environ["CONDENSE_HF_REPO"]
files = [item for item in os.environ.get("CONDENSE_HF_FILES", "").split() if item]
kwargs = {"allow_patterns": files} if files else {}
snapshot_download(repo, **kwargs)
PY
  fi
  return 1
}

curl_hf_files() {
  repo="$1"
  shift
  cache_root="$(hf_hub_cache)"
  repo_dir="$cache_root/models--$(printf '%s' "$repo" | sed 's|/|--|g')"
  first="$1"
  resolved="$(curl -fsSL -o /dev/null -w '%{url_effective}' -L "https://huggingface.co/${repo}/resolve/main/${first}" || true)"
  revision="$(printf '%s' "$resolved" | sed -n 's|.*/resolve/\([^/]*\)/.*|\1|p')"
  if [ -z "$revision" ] || [ "$revision" = "main" ]; then
    revision="main"
  fi
  snap_dir="$repo_dir/snapshots/$revision"
  mkdir -p "$snap_dir" "$repo_dir/refs"
  printf '%s\n' "$revision" > "$repo_dir/refs/main"
  for file in "$@"; do
    dest="$snap_dir/$file"
    if [ -s "$dest" ]; then
      echo "[condense] Cached $file"
      continue
    fi
    echo "[condense] Downloading $file..."
    mkdir -p "$(dirname "$dest")"
    if ! curl -fL --retry 3 --progress-bar "https://huggingface.co/${repo}/resolve/main/${file}" -o "$dest"; then
      return 1
    fi
  done
  return 0
}

prefetch_local_model() {
  if [ "$TARGET" = "darwin-arm64" ]; then
    HF_REPO="samuelfaj/distill2-0.6B-4bit-MLX"
    HF_FILES="added_tokens.json chat_template.jinja config.json generation_config.json merges.txt model.safetensors model.safetensors.index.json special_tokens_map.json tokenizer.json tokenizer_config.json vocab.json"
  else
    HF_REPO="samuelfaj/distill2-0.6B-4bit-GGUF"
    HF_FILES="distill2-0.6B-Q4_K_M.GGUF"
  fi
  echo "[condense] Prefetching $HF_REPO (~404 MB)..."
  # shellcheck disable=SC2086
  prefetch_hf_repo "$HF_REPO" $HF_FILES && return 0
  # shellcheck disable=SC2086
  curl_hf_files "$HF_REPO" $HF_FILES
}

if [ "${CONDENSE_SKIP_WARMUP:-}" != "1" ]; then
  echo "[condense] Downloading and loading local 0.6B model..."
  if prefetch_local_model; then
    echo "[condense] Local model weights cached."
  else
    echo "[condense] Warning: could not prefetch model weights from Hugging Face."
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

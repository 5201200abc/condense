#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
model_4bit="${MODEL_4BIT:-$root/train/models/Qwen3.5-0.8B-Base-4bit}"
adapter="${ADAPTER_PATH:-$root/train/adapters/test}"
fused="${FUSED_PATH:-$root/train/models/Qwen3.5-0.8B-fused}"
gguf_dir="${GGUF_DIR:-$root/train/gguf}"
f16_gguf="$gguf_dir/condense-0.8B-f16.gguf"
q4_gguf="$gguf_dir/condense-0.8B-Q4_K_M.gguf"
convert_dir="${LLAMA_CPP_CONVERT:-/tmp/llama.cpp-latest}"
convert_py="${CONVERT_PYTHON:-/tmp/gguf-venv/bin/python}"
wrapper="$root/train/scripts/convert_qwen35_to_gguf.py"

mkdir -p "$gguf_dir"

if [[ ! -f "$adapter/adapters.safetensors" ]]; then
  echo "missing adapter: $adapter/adapters.safetensors" >&2
  exit 1
fi

echo "fusing $adapter into $fused"
mlx_lm.fuse \
  --model "$model_4bit" \
  --adapter-path "$adapter" \
  --save-path "$fused" \
  --dequantize

if [[ ! -f "$convert_dir/convert_hf_to_gguf.py" ]]; then
  echo "missing convert_hf_to_gguf.py in $convert_dir (set LLAMA_CPP_CONVERT, default /tmp/llama.cpp-latest)" >&2
  exit 1
fi
if [[ ! -x "$convert_py" ]]; then
  echo "missing converter python: $convert_py (set CONVERT_PYTHON)" >&2
  exit 1
fi

if [[ ! -f "$wrapper" ]]; then
  echo "missing $wrapper" >&2
  exit 1
fi

echo "converting $fused -> $f16_gguf (Qwen3.5 RMSNorm unshifted, --no-mtp)"
LLAMA_CPP_CONVERT="$convert_dir" "$convert_py" "$wrapper" \
  "$fused" \
  --outfile "$f16_gguf" \
  --outtype f16 \
  --no-mtp

echo "quantizing $f16_gguf -> $q4_gguf"
llama-quantize "$f16_gguf" "$q4_gguf" Q4_K_M
ls -lh "$q4_gguf"

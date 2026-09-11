#!/usr/bin/env python3
"""llama.cpp convert_hf_to_gguf.py for Qwen3.5 with RMSNorm left unshifted.

convert_hf_to_gguf.py adds +1 to most *.norm.weight for Qwen3-Next. Qwen3.5
HF/MLX weights are already the full scale (fused layer0 attn_norm mean 1.2384;
working unsloth GGUF is 1.2376). The extra +1 makes F16 llama.cpp output
garbage. This wrapper subtracts 1 before that path so Qwen3.5 GGUF matches
fused MLX. Always pass --no-mtp: without it block_count becomes 25 and
llama-server fails looking for blk.24.*.
"""

from __future__ import annotations

import os
import runpy
import sys
from pathlib import Path

convert_dir = Path(os.environ.get("LLAMA_CPP_CONVERT", "/tmp/llama.cpp-latest")).resolve()
convert_py = convert_dir / "convert_hf_to_gguf.py"
if not convert_py.is_file():
    raise SystemExit(f"missing {convert_py} (set LLAMA_CPP_CONVERT)")

sys.path.insert(0, str(convert_dir))
sys.path.insert(0, str(convert_dir / "gguf-py"))

import gguf
from conversion.qwen import Qwen3NextModel

_orig = Qwen3NextModel.modify_tensors
_qwen35 = {gguf.MODEL_ARCH.QWEN35}
if hasattr(gguf.MODEL_ARCH, "QWEN35MOE"):
    _qwen35.add(gguf.MODEL_ARCH.QWEN35MOE)


def modify_tensors(self, data_torch, name, bid):
    if getattr(self, "model_arch", None) in _qwen35:
        if name.endswith("norm.weight") and not name.endswith("linear_attn.norm.weight"):
            data_torch = data_torch - 1
    return _orig(self, data_torch, name, bid)


Qwen3NextModel.modify_tensors = modify_tensors

argv = sys.argv[1:]
if "--no-mtp" not in argv:
    argv.append("--no-mtp")
sys.argv = [str(convert_py), *argv]
os.chdir(convert_dir)
runpy.run_path(str(convert_py), run_name="__main__")

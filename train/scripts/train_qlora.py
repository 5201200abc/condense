#!/usr/bin/env python3
"""mlx_lm.lora with Qwen3.5 thinking disabled in the chat template.

mlx_lm.tokenizer_utils.TokenizerWrapper.apply_chat_template defaults
enable_thinking to has_thinking (True for Qwen3.5). That makes the
--mask-prompt offset end at an *open* <think> tag, while the full
assistant turn already contains the closed empty think block. Passing
enable_thinking=False makes prefix == official no-think generation prompt
so loss lands on assistant content + <|im_end|>.
"""

import mlx.core as mx
from mlx_lm.tokenizer_utils import TokenizerWrapper
from mlx_lm.utils import load as _mlx_load

# Metal keeps a buffer cache that fragments across long QLoRA runs and
# eventually OOMs (~9GB peak on this 0.8B + 768 seq job). Disable it.
mx.set_cache_limit(0)

_orig_apply = TokenizerWrapper.apply_chat_template
_orig_load = _mlx_load


def apply_chat_template(self, *args, tokenize=True, **kwargs):
    kwargs["enable_thinking"] = False
    return _orig_apply(self, *args, tokenize=tokenize, **kwargs)


def load(*args, **kwargs):
    model, tokenizer = _orig_load(*args, **kwargs)
    if hasattr(tokenizer, "add_eos_token"):
        try:
            tokenizer.add_eos_token("<|im_end|>")
        except ValueError:
            pass
    return model, tokenizer


TokenizerWrapper.apply_chat_template = apply_chat_template

import mlx_lm.utils as mlx_utils
import mlx_lm.lora as mlx_lora

mlx_utils.load = load
mlx_lora.load = load

from mlx_lm.lora import main

if __name__ == "__main__":
    main()

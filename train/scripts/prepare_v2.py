#!/usr/bin/env python3
"""Fit the frozen 1K labels into Qwen3.5's official chat template.

mlx_lm --mask-prompt NaNs when ChatDataset offset >= truncated length:
trainer keeps the LEFT prefix (system+user) and does not shrink offset, so
the assistant span — including <|im_end|> — is dropped and CE is 0/0.

This writer truncates USER only so every row satisfies:
  len(full) <= max_seq
  len(prefix) < len(full)          # at least one trained token
  <|im_end|> sits inside the trained span
and so prefix == apply_chat_template(messages[:-1], add_generation_prompt=True,
                                     enable_thinking=False).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from transformers import AutoTokenizer

ROOT = Path(__file__).resolve().parents[2]
MODEL = ROOT / "train/models/Qwen3.5-0.8B-Base-4bit"
LABELED = ROOT / "train/data/labeled"
OFFICIAL = ROOT / "train/data/official"
OUT_DIR = ROOT / "train/data/v2"
IM_END = "<|im_end|>"
QUESTION_MARK = "\n\nQuestion: "


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows = []
    with path.open() as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def compact_system() -> str:
    row = load_jsonl(OFFICIAL / "train.jsonl")[0]
    for msg in row["messages"]:
        if msg["role"] == "system":
            return msg["content"]
    raise SystemExit("official train.jsonl missing system message")


def split_user(user: str) -> tuple[str, str]:
    if QUESTION_MARK in user:
        body, question = user.rsplit(QUESTION_MARK, 1)
        return body, question
    return user, ""


def join_user(body: str, question: str) -> str:
    if not question:
        return body
    return f"{body}{QUESTION_MARK}{question}"


def clip_body(body: str, max_chars: int) -> str:
    if max_chars <= 0:
        prefix = "Command output:" if body.startswith("Command output:") else ""
        return prefix
    if len(body) <= max_chars:
        return body
    half = max(1, max_chars // 2 - 24)
    dropped = len(body) - 2 * half
    return f"{body[:half]}\n... [{dropped} chars truncated] ...\n{body[-half:]}"


def roles(messages: list[dict[str, str]]) -> dict[str, str]:
    out = {m["role"]: m["content"] for m in messages}
    if not {"system", "user", "assistant"} <= out.keys():
        raise ValueError("expected system/user/assistant messages")
    return out


def encode(
    tokenizer,
    system: str,
    user: str,
    assistant: str | None,
    enable_thinking: bool,
) -> list[int]:
    messages: list[dict[str, str]] = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    kwargs = {
        "tokenize": True,
        "return_dict": False,
        "enable_thinking": enable_thinking,
        "add_generation_prompt": assistant is None,
    }
    if assistant is not None:
        messages.append({"role": "assistant", "content": assistant})
    return tokenizer.apply_chat_template(messages, **kwargs)


def inspect(
    tokenizer,
    system: str,
    user: str,
    assistant: str,
    enable_thinking: bool,
) -> dict[str, Any]:
    full = encode(tokenizer, system, user, assistant, enable_thinking)
    prefix = encode(tokenizer, system, user, None, enable_thinking)
    im_end_id = tokenizer.convert_tokens_to_ids(IM_END)
    prefix_ok = full[: len(prefix)] == prefix
    trained = full[len(prefix) :]
    return {
        "full_len": len(full),
        "offset": len(prefix),
        "trained": len(trained),
        "prefix_ok": prefix_ok,
        "im_end_id": im_end_id,
        "im_end_in_trained": im_end_id in trained,
        "ends_with_im_end": bool(trained) and trained[-1] == im_end_id
        or (len(trained) >= 2 and trained[-2] == im_end_id),
        "full": full,
        "prefix": prefix,
    }


def ntoks_after_left_truncate(offset: int, full_len: int, max_seq: int) -> int:
    length = min(full_len, max_seq)
    # mlx_lm.tuner.trainer.default_loss: steps in 1..len(targets), mask
    # steps >= offset AND steps <= length. targets = batch[:, 1:].
    if offset >= length:
        return 0
    return length - offset


def pack(
    tokenizer,
    system: str,
    user: str,
    assistant: str,
    row: dict[str, Any],
    orig_user: str,
    orig_assistant: str,
    max_seq: int,
    enable_thinking: bool,
) -> dict[str, Any] | None:
    info = inspect(tokenizer, system, user, assistant, enable_thinking)
    ntoks = ntoks_after_left_truncate(info["offset"], info["full_len"], max_seq)
    if not (
        info["full_len"] <= max_seq
        and ntoks > 0
        and info["prefix_ok"]
        and info["im_end_in_trained"]
    ):
        return None
    return {
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
            {"role": "assistant", "content": assistant},
        ],
        "metadata": {
            **(row.get("metadata") or {}),
            "full_len": info["full_len"],
            "offset": info["offset"],
            "trained": info["trained"],
            "user_chars": len(user),
            "user_truncated": user != orig_user,
            "assistant_truncated": assistant != orig_assistant,
            "system": "compact",
        },
    }


def binary_fit_user(
    tokenizer,
    row: dict[str, Any],
    system: str,
    body: str,
    question: str,
    assistant: str,
    max_seq: int,
    enable_thinking: bool,
) -> dict[str, Any] | None:
    orig_user = roles(row["messages"])["user"]
    lo, hi = 0, len(body)
    best = None
    while lo <= hi:
        mid = (lo + hi) // 2
        user = join_user(clip_body(body, mid), question)
        packed = pack(
            tokenizer,
            system,
            user,
            assistant,
            row,
            orig_user,
            assistant,
            max_seq,
            enable_thinking,
        )
        if packed:
            best = packed
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def binary_fit_assistant(
    tokenizer,
    row: dict[str, Any],
    system: str,
    user: str,
    assistant: str,
    max_seq: int,
    enable_thinking: bool,
) -> dict[str, Any] | None:
    orig_user = roles(row["messages"])["user"]
    lo, hi = 1, len(assistant)
    best = None
    while lo <= hi:
        mid = (lo + hi) // 2
        clipped = assistant[:mid]
        packed = pack(
            tokenizer,
            system,
            user,
            clipped,
            row,
            orig_user,
            assistant,
            max_seq,
            enable_thinking,
        )
        if packed:
            best = packed
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def fit_row(
    tokenizer,
    row: dict[str, Any],
    system: str,
    max_seq: int,
    enable_thinking: bool,
) -> dict[str, Any] | None:
    parts = roles(row["messages"])
    assistant = parts["assistant"]
    body, question = split_user(parts["user"])
    fitted = binary_fit_user(
        tokenizer, row, system, body, question, assistant, max_seq, enable_thinking
    )
    if fitted is not None:
        return fitted
    user = join_user(clip_body(body, 0), question)
    return binary_fit_assistant(
        tokenizer, row, system, user, assistant, max_seq, enable_thinking
    )


def diagnose_file(
    tokenizer,
    path: Path,
    max_seq: int,
    enable_thinking: bool,
    use_row_system: bool,
    compact: str,
) -> dict[str, Any]:
    rows = load_jsonl(path)
    nan_ids = []
    mismatch = 0
    missing_im_end = 0
    full_lens = []
    offsets = []
    ntoks_list = []
    for row in rows:
        parts = roles(row["messages"])
        system = parts["system"] if use_row_system else compact
        info = inspect(
            tokenizer, system, parts["user"], parts["assistant"], enable_thinking
        )
        ntoks = ntoks_after_left_truncate(info["offset"], info["full_len"], max_seq)
        full_lens.append(info["full_len"])
        offsets.append(info["offset"])
        ntoks_list.append(ntoks)
        if not info["prefix_ok"]:
            mismatch += 1
        if not info["im_end_in_trained"] and ntoks > 0:
            missing_im_end += 1
        if ntoks == 0:
            nan_ids.append((row.get("metadata") or {}).get("id"))
    full_lens.sort()
    offsets.sort()

    def pct(xs: list[int], p: float) -> int:
        if not xs:
            return 0
        i = min(len(xs) - 1, max(0, int(round(p * (len(xs) - 1)))))
        return xs[i]

    return {
        "path": str(path),
        "n": len(rows),
        "enable_thinking": enable_thinking,
        "system": "row" if use_row_system else "compact",
        "max_seq": max_seq,
        "nan_batches": len(nan_ids),
        "prefix_mismatch": mismatch,
        "missing_im_end_in_window": missing_im_end,
        "full_p50": pct(full_lens, 0.5),
        "full_p90": pct(full_lens, 0.9),
        "full_max": full_lens[-1] if full_lens else 0,
        "offset_p50": pct(offsets, 0.5),
        "offset_p90": pct(offsets, 0.9),
        "offset_max": offsets[-1] if offsets else 0,
        "ntoks_min": min(ntoks_list) if ntoks_list else 0,
        "sample_nan_ids": nan_ids[:8],
        "im_end_id": tokenizer.convert_tokens_to_ids(IM_END),
        "eos_id": tokenizer.eos_token_id,
        "eos_token": tokenizer.eos_token,
    }


def write_split(
    tokenizer,
    src: Path,
    dest: Path,
    system: str,
    max_seq: int,
) -> dict[str, Any]:
    rows = load_jsonl(src)
    kept = []
    dropped = []
    truncated = 0
    asst_truncated = 0
    for row in rows:
        fitted = fit_row(tokenizer, row, system, max_seq, enable_thinking=False)
        if fitted is None:
            dropped.append((row.get("metadata") or {}).get("id"))
            continue
        if fitted["metadata"]["user_truncated"]:
            truncated += 1
        if fitted["metadata"].get("assistant_truncated"):
            asst_truncated += 1
        kept.append(fitted)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("w") as fh:
        for row in kept:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    return {
        "src": str(src),
        "dest": str(dest),
        "kept": len(kept),
        "dropped": len(dropped),
        "dropped_ids": dropped,
        "user_truncated": truncated,
        "assistant_truncated": asst_truncated,
        "full_max": max((r["metadata"]["full_len"] for r in kept), default=0),
        "offset_max": max((r["metadata"]["offset"] for r in kept), default=0),
        "trained_min": min((r["metadata"]["trained"] for r in kept), default=0),
    }


def load_tokenizer(model: Path):
    tokenizer = AutoTokenizer.from_pretrained(str(model), trust_remote_code=True)
    jinja = model / "chat_template.jinja"
    if tokenizer.chat_template is None and jinja.exists():
        tokenizer.chat_template = jinja.read_text()
    if tokenizer.chat_template is None:
        raise SystemExit(f"no chat template on {model}")
    return tokenizer


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=MODEL)
    parser.add_argument("--max-seq", type=int, default=768)
    parser.add_argument("--out", type=Path, default=OUT_DIR)
    parser.add_argument("--diagnose-only", action="store_true")
    parser.add_argument("--skip-diagnose", action="store_true")
    args = parser.parse_args()

    tokenizer = load_tokenizer(args.model)
    compact = compact_system()
    im_end_id = tokenizer.convert_tokens_to_ids(IM_END)
    print(
        json.dumps(
            {
                "im_end_id": im_end_id,
                "im_end_token": tokenizer.convert_ids_to_tokens(im_end_id)
                if isinstance(im_end_id, int)
                else None,
                "eos_id": tokenizer.eos_token_id,
                "eos_token": tokenizer.eos_token,
                "compact_system_chars": len(compact),
            },
            indent=2,
        )
    )

    if not args.skip_diagnose:
        reports = []
        for path, use_row in (
            (LABELED / "train.jsonl", True),
            (OFFICIAL / "train.jsonl", True),
        ):
            if not path.exists():
                continue
            for thinking in (False, True):
                reports.append(
                    diagnose_file(
                        tokenizer,
                        path,
                        args.max_seq,
                        thinking,
                        use_row,
                        compact,
                    )
                )
        print(json.dumps({"diagnose": reports}, indent=2))
        if args.diagnose_only:
            return 0

    stats = {
        "max_seq": args.max_seq,
        "enable_thinking": False,
        "train": write_split(
            tokenizer, LABELED / "train.jsonl", args.out / "train.jsonl", compact, args.max_seq
        ),
        "valid": write_split(
            tokenizer, LABELED / "valid.jsonl", args.out / "valid.jsonl", compact, args.max_seq
        ),
    }
    # Post-check v2 with the same tokenizer the writer used.
    stats["verify"] = [
        diagnose_file(
            tokenizer, args.out / name, args.max_seq, False, True, compact
        )
        for name in ("train.jsonl", "valid.jsonl")
    ]
    (args.out / "stats.json").write_text(json.dumps(stats, indent=2) + "\n")
    print(json.dumps(stats, indent=2))
    bad = [
        v
        for v in stats["verify"]
        if v["nan_batches"] or v["prefix_mismatch"] or v["missing_im_end_in_window"]
    ]
    if bad or stats["train"]["dropped"] or stats["valid"]["dropped"]:
        print("prepare_v2: rows dropped or mask still empty", file=sys.stderr)
        return 1
    sample = load_jsonl(args.out / "train.jsonl")[0]
    rendered = tokenizer.apply_chat_template(
        sample["messages"],
        tokenize=False,
        add_generation_prompt=False,
        enable_thinking=False,
    )
    (args.out / "sample_rendered.txt").write_text(rendered)
    if not rendered.rstrip().endswith(IM_END):
        print("sample does not end with <|im_end|>", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

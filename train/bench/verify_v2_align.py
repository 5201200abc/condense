#!/usr/bin/env python3
"""v2 compact-system 6-task bench + fused MLX vs F16 vs Q4 chat completions."""

from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PREV = ROOT / "train/bench/official_vs_distill2.json"
LABELED = ROOT / "train/data/labeled"
V2_TRAIN = ROOT / "train/data/v2/train.jsonl"
FUSED = ROOT / "train/models/Qwen3.5-0.8B-v2-fused"
OUT = ROOT / "train/bench/v2_compact_vs_gguf.json"


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    with path.open() as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def compact_system() -> str:
    row = load_jsonl(V2_TRAIN)[0]
    return next(m["content"] for m in row["messages"] if m["role"] == "system")


def tasks() -> list[dict]:
    prev = json.loads(PREV.read_text())
    seen: set[str] = set()
    out = []
    for row in prev.get("results") or []:
        if row.get("model") != "distill2-0.6B":
            continue
        rid = row["id"]
        if rid in seen:
            continue
        seen.add(rid)
        out.append(row)
    return out


def labeled_by_id() -> dict[str, dict]:
    catalog: dict[str, dict] = {}
    for name in ("train.jsonl", "valid.jsonl", "accepted.jsonl"):
        path = LABELED / name
        if not path.exists():
            continue
        for row in load_jsonl(path):
            rid = (row.get("metadata") or {}).get("id")
            if rid:
                catalog[rid] = row
    return catalog


def post_json(url: str, body: dict, timeout: float) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return {"ok": True, "payload": json.loads(res.read().decode("utf-8"))}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        return {"ok": False, "error": f"HTTP {exc.code}: {raw[:500]}"}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)[:500]}


def chat_completions(
    host: str,
    model: str,
    system: str,
    user: str,
    max_tokens: int,
    timeout: float,
) -> dict:
    t0 = time.perf_counter()
    result = post_json(
        host.rstrip("/") + "/v1/chat/completions",
        {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0,
            "max_tokens": max_tokens,
            "chat_template_kwargs": {"enable_thinking": False},
            "cache_prompt": True,
        },
        timeout,
    )
    sec = round(time.perf_counter() - t0, 2)
    if not result.get("ok"):
        return {"pred": "", "error": result.get("error", "unknown"), "sec": sec}
    payload = result["payload"]
    choices = payload.get("choices") or []
    msg = (choices[0].get("message") or {}) if choices else {}
    pred = (msg.get("content") or "").strip()
    return {"pred": pred, "error": None, "sec": sec, "finish": msg.get("reasoning_content")}


def run_llamacpp(
    name: str,
    host: str,
    model_name: str,
    system: str,
    max_tokens: int,
    timeout: float,
) -> list[dict]:
    catalog = labeled_by_id()
    rows = []
    for task in tasks():
        src = catalog[task["id"]]
        user = next(m["content"] for m in src["messages"] if m["role"] == "user")
        gold = next(m["content"] for m in src["messages"] if m["role"] == "assistant")
        rec = chat_completions(host, model_name, system, user, max_tokens, timeout)
        rows.append(
            {
                "model": name,
                "id": task["id"],
                "task": task["task"],
                "gold": gold[:240],
                "pred": (rec.get("pred") or "")[:500],
                "error": rec.get("error"),
                "sec": rec["sec"],
            }
        )
        shown = rec.get("error") or rec.get("pred") or ""
        print(
            f"{name} {task['id']} {task['task']} {rec['sec']}s "
            f"{shown[:160].replace(chr(10), ' / ')}",
            flush=True,
        )
    return rows


def run_mlx_all(system: str, max_tokens: int) -> tuple[list[dict], str]:
    from mlx_lm import generate, load
    from mlx_lm.sample_utils import make_sampler

    model, tokenizer = load(str(FUSED))
    try:
        tokenizer.add_eos_token("<|im_end|>")
    except Exception:
        pass
    sampler = make_sampler(0.0)
    catalog = labeled_by_id()
    rows = []
    rendered_tail = ""
    for task in tasks():
        src = catalog[task["id"]]
        user = next(m["content"] for m in src["messages"] if m["role"] == "user")
        gold = next(m["content"] for m in src["messages"] if m["role"] == "assistant")
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        prompt = tokenizer.apply_chat_template(
            messages,
            add_generation_prompt=True,
            enable_thinking=False,
            tokenize=False,
        )
        rendered_tail = prompt[-160:]
        t0 = time.perf_counter()
        pred = generate(
            model,
            tokenizer,
            prompt=prompt,
            max_tokens=max_tokens,
            sampler=sampler,
            verbose=False,
        )
        sec = round(time.perf_counter() - t0, 2)
        text = (pred or "").strip()
        rows.append(
            {
                "model": "v2-fused-mlx-compact",
                "id": task["id"],
                "task": task["task"],
                "gold": gold[:240],
                "pred": text[:500],
                "error": None,
                "sec": sec,
                "has_empty_think": "<think>\n\n</think>" in prompt,
            }
        )
        print(
            f"mlx {task['id']} {task['task']} {sec}s {text[:160].replace(chr(10), ' / ')}",
            flush=True,
        )
    return rows, rendered_tail


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", choices=("mlx", "llamacpp"), required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--host", default="http://127.0.0.1:8011")
    parser.add_argument("--model", default="condense-v2")
    parser.add_argument("--max-tokens", type=int, default=128)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--append", action="store_true")
    args = parser.parse_args()

    system = compact_system()
    if "Examples:" in system or "worker-xy" in system:
        raise SystemExit("v2 compact system still contains few-shot")
    (ROOT / "train/bench/system-prompt.txt").write_text(system)

    if args.backend == "mlx":
        rows, tail = run_mlx_all(system, args.max_tokens)
        extra = {"rendered_tail": tail, "system_chars": len(system)}
    else:
        rows = run_llamacpp(
            args.name,
            args.host,
            args.model,
            system,
            args.max_tokens,
            args.timeout,
        )
        extra = {"system_chars": len(system)}

    blob = {"results": rows, **extra}
    if args.append and args.out.exists():
        prev = json.loads(args.out.read_text())
        prev.setdefault("results", []).extend(rows)
        prev.update(extra)
        args.out.write_text(json.dumps(prev, indent=2) + "\n")
    else:
        args.out.write_text(json.dumps(blob, indent=2) + "\n")
    print(json.dumps({"n": len(rows), "name": args.name, **extra}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

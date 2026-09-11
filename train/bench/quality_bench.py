#!/usr/bin/env python3
"""Replay the frozen 6-task official_vs_distill2 set against HTTP chat endpoints."""

from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BENCH = ROOT / "train/bench/official_vs_distill2.json"
LABELED = ROOT / "train/data/labeled"
SYSTEM = ROOT / "train/bench/system-prompt.txt"


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    with path.open() as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def labeled_by_id() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for name in ("train.jsonl", "valid.jsonl", "accepted.jsonl"):
        path = LABELED / name
        if not path.exists():
            continue
        for row in load_jsonl(path):
            rid = (row.get("metadata") or {}).get("id")
            if rid:
                out[rid] = row
    return out


def tasks_from_prev() -> list[dict]:
    prev = json.loads(BENCH.read_text())
    seen: set[str] = set()
    tasks = []
    for row in prev.get("results") or []:
        rid = row.get("id")
        if not rid or rid in seen:
            continue
        if row.get("model") != "distill2-0.6B":
            continue
        seen.add(rid)
        tasks.append(row)
    return tasks


def post(url: str, body: dict, timeout: float) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {raw[:400]}") from exc


def chat(
    host: str,
    model: str,
    system: str,
    user: str,
    timeout: float,
    max_tokens: int,
    mode: str,
) -> str:
    if mode == "completion":
        prompt = (
            "<|im_start|>system\n"
            f"{system}<|im_end|>\n"
            "<|im_start|>user\n"
            f"{user}<|im_end|>\n"
            "<|im_start|>assistant\n"
            "<think>\n\n</think>\n\n"
        )
        payload = post(
            host.rstrip("/") + "/completion",
            {
                "prompt": prompt,
                "temperature": 0,
                "n_predict": max_tokens,
                "stop": ["<|im_end|>", "<|endoftext|>"],
                "cache_prompt": True,
            },
            timeout,
        )
        return (payload.get("content") or "").strip()
    payload = post(
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
    choices = payload.get("choices") or []
    if not choices:
        return ""
    msg = choices[0].get("message") or {}
    return (msg.get("content") or "").strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", required=True)
    parser.add_argument("--host", required=True)
    parser.add_argument("--model", default="condense-local")
    parser.add_argument("--max-tokens", type=int, default=256)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--append", type=Path, default=None)
    parser.add_argument(
        "--mode",
        choices=("chat", "completion"),
        default="completion",
        help="completion uses the official no-think Qwen prefix and stops on <|im_end|>",
    )
    args = parser.parse_args()

    system = SYSTEM.read_text()
    catalog = labeled_by_id()
    results = []
    for task in tasks_from_prev():
        row = catalog.get(task["id"])
        if not row:
            raise SystemExit(f"missing labeled row {task['id']}")
        user = next(m["content"] for m in row["messages"] if m["role"] == "user")
        gold = next(m["content"] for m in row["messages"] if m["role"] == "assistant")
        t0 = time.perf_counter()
        pred = chat(
            args.host,
            args.model,
            system,
            user,
            args.timeout,
            args.max_tokens,
            args.mode,
        )
        results.append(
            {
                "model": args.name,
                "id": task["id"],
                "task": task["task"],
                "gold": gold[:240],
                "pred": pred[:500],
                "sec": round(time.perf_counter() - t0, 2),
            }
        )
        print(f"{args.name} {task['id']} {task['task']} {results[-1]['sec']}s", flush=True)
        print(pred[:240].replace("\n", " / "), flush=True)

    blob = {"results": results}
    if args.out:
        args.out.write_text(json.dumps(blob, indent=2) + "\n")
    if args.append:
        prev = {"results": []}
        if args.append.exists():
            prev = json.loads(args.append.read_text())
        prev.setdefault("results", []).extend(results)
        args.append.write_text(json.dumps(prev, indent=2) + "\n")
    print(json.dumps(blob, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

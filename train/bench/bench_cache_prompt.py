#!/usr/bin/env python3
"""Compare llama.cpp cache_prompt=false vs true TTFT on a frozen system prefix."""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def post_json(url: str, body: dict, timeout: float) -> dict:
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
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            raise RuntimeError(f"HTTP {exc.code}: {raw[:300]}") from exc
        if "timings" in payload:
            return payload
        print(f"warn HTTP {exc.code}: {raw[:160]}", flush=True)
        return {"timings": {}, "error": raw}


def extract_timings(payload: dict) -> dict:
    timings = payload.get("timings") or payload.get("usage") or {}
    prompt_ms = timings.get("prompt_ms")
    prompt_n = timings.get("prompt_n") or timings.get("prompt_tokens")
    cache_n = timings.get("cache_n")
    predicted_ms = timings.get("predicted_ms")
    predicted_n = timings.get("predicted_n")
    content = ""
    choices = payload.get("choices") or []
    if choices:
        content = ((choices[0].get("message") or {}).get("content") or "").strip()
    wall_ms = None
    return {
        "prompt_ms": prompt_ms,
        "prompt_n": prompt_n,
        "cache_n": cache_n,
        "predicted_ms": predicted_ms,
        "predicted_n": predicted_n,
        "content": content[:80],
    }


def run_series(
    url: str,
    system: str,
    question: str,
    outputs: list[str],
    cache_prompt: bool,
    max_tokens: int,
    timeout: float,
) -> list[dict]:
    rows = []
    for i, terminal in enumerate(outputs):
        user = f"Command output:\n{terminal}\n\nQuestion: {question}"
        t0 = time.perf_counter()
        prompt = (
            "<|im_start|>system\n"
            f"{system}<|im_end|>\n"
            "<|im_start|>user\n"
            f"{user}<|im_end|>\n"
            "<|im_start|>assistant\n"
            "<think>\n\n</think>\n\n"
        )
        payload = post_json(
            url,
            {
                "prompt": prompt,
                "temperature": 0,
                "n_predict": max_tokens,
                "cache_prompt": cache_prompt,
            },
            timeout,
        )
        wall_ms = (time.perf_counter() - t0) * 1000
        row = extract_timings(payload)
        row["wall_ms"] = round(wall_ms, 2)
        row["cache_prompt"] = cache_prompt
        row["i"] = i
        rows.append(row)
        print(
            f"cache_prompt={cache_prompt} i={i:02d} wall_ms={row['wall_ms']:.1f} "
            f"prompt_ms={row['prompt_ms']} prompt_n={row['prompt_n']} "
            f"cache_n={row['cache_n']}",
            flush=True,
        )
    return rows


def summarize(name: str, rows: list[dict], skip: int = 0) -> dict:
    used = rows[skip:]
    prompt_ms = [r["prompt_ms"] for r in used if r["prompt_ms"] is not None]
    wall_ms = [r["wall_ms"] for r in used]
    cache_n = [r["cache_n"] for r in used if r["cache_n"] is not None]
    prompt_n = [r["prompt_n"] for r in used if r["prompt_n"] is not None]
    return {
        "name": name,
        "n": len(used),
        "prompt_ms_mean": round(statistics.mean(prompt_ms), 2) if prompt_ms else None,
        "prompt_ms_median": round(statistics.median(prompt_ms), 2) if prompt_ms else None,
        "wall_ms_mean": round(statistics.mean(wall_ms), 2),
        "wall_ms_median": round(statistics.median(wall_ms), 2),
        "cache_n_mean": round(statistics.mean(cache_n), 2) if cache_n else None,
        "prompt_n_mean": round(statistics.mean(prompt_n), 2) if prompt_n else None,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="http://127.0.0.1:8010")
    parser.add_argument("--system-file", type=Path, required=True)
    parser.add_argument("--uncached-n", type=int, default=8)
    parser.add_argument("--cached-n", type=int, default=20)
    parser.add_argument("--max-tokens", type=int, default=32)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    system = args.system_file.read_text()
    question = "Did tests pass? Return PASS or FAIL, followed by failing test names if any."
    url = args.host.rstrip("/") + "/completion"

    uncached_outputs = [
        f"{20 + i} tests passed, {i % 3} failed\nFAIL test/auth_{i}.test.ts"
        for i in range(args.uncached_n)
    ]
    cached_outputs = [
        f"{40 + i} tests passed, {i % 2} failed\nFAIL test/queue_{i}.test.ts"
        for i in range(args.cached_n)
    ]

    print("== uncached cache_prompt=false ==", flush=True)
    uncached = run_series(url, system, question, uncached_outputs, False, args.max_tokens, args.timeout)
    print("== cached cache_prompt=true ==", flush=True)
    cached = run_series(url, system, question, cached_outputs, True, args.max_tokens, args.timeout)

    report = {
        "uncached_all": summarize("uncached", uncached, skip=0),
        "uncached_steady": summarize("uncached_steady", uncached, skip=1),
        "cached_all": summarize("cached", cached, skip=0),
        "cached_steady": summarize("cached_steady", cached, skip=1),
        "rows": {"uncached": uncached, "cached": cached},
    }
    u = report["uncached_steady"]["prompt_ms_median"]
    c = report["cached_steady"]["prompt_ms_median"]
    if u and c and u > 0:
        report["prompt_ms_ratio"] = round(c / u, 3)
        report["prompt_ms_drop_pct"] = round((1 - c / u) * 100, 1)
    else:
        report["prompt_ms_ratio"] = None
        report["prompt_ms_drop_pct"] = None

    print(json.dumps({k: v for k, v in report.items() if k != "rows"}, indent=2))
    if args.out:
        args.out.write_text(json.dumps(report, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

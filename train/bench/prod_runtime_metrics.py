#!/usr/bin/env python3
"""TTFT, cache_prompt hit, and fallback restart on the production llama.cpp server."""

from __future__ import annotations

import json
import os
import statistics
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GGUF = ROOT / "train/gguf/v2/condense-0.8B-Q4_K_M.gguf"
CLI = ROOT / "src/cli.ts"
SYSTEM = ROOT / "train/bench/system-prompt.txt"
OUT = ROOT / "train/bench/prod_runtime_metrics.json"
HOST = "http://127.0.0.1:8009"


def post(path: str, body: dict, timeout: float = 60) -> dict:
    req = urllib.request.Request(
        HOST.rstrip("/") + path,
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            payload = json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {raw[:300]}") from exc
    payload["_wall_ms"] = round((time.perf_counter() - t0) * 1000, 2)
    return payload


def chat(system: str, user: str, cache_prompt: bool, max_tokens: int = 32) -> dict:
    payload = post(
        "/v1/chat/completions",
        {
            "model": "condense-local",
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0,
            "max_tokens": max_tokens,
            "cache_prompt": cache_prompt,
            "chat_template_kwargs": {"enable_thinking": False},
        },
    )
    timings = payload.get("timings") or {}
    content = ""
    choices = payload.get("choices") or []
    if choices:
        content = ((choices[0].get("message") or {}).get("content") or "").strip()
    return {
        "wall_ms": payload["_wall_ms"],
        "prompt_ms": timings.get("prompt_ms"),
        "prompt_n": timings.get("prompt_n") or timings.get("prompt_tokens"),
        "cache_n": timings.get("cache_n"),
        "predicted_ms": timings.get("predicted_ms"),
        "predicted_n": timings.get("predicted_n"),
        "content": content[:80],
    }


def pid_on_port(port: int) -> int | None:
    proc = subprocess.run(
        ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
        capture_output=True,
        text=True,
    )
    for line in proc.stdout.split():
        if line.isdigit():
            return int(line)
    return None


def main() -> int:
    system = SYSTEM.read_text()
    env = os.environ.copy()
    env["CONDENSE_LLAMA_GGUF"] = str(GGUF)
    env["CONDENSE_PROVIDER"] = "local"
    env["CONDENSE_LOCAL_BACKEND"] = "llamacpp"
    env["CONDENSE_AUTO_LEARN"] = "false"
    env["CONDENSE_DATASET_ENABLED"] = "false"
    warmup = subprocess.run(
        ["bun", "run", str(CLI), "warmup"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    print(warmup.stdout.strip() or warmup.stderr[-200:], flush=True)
    uncached = []
    cached = []
    for i in range(6):
        user = (
            f"Command output:\n{20 + i} tests passed, {i % 3} failed\n"
            f"FAIL test/auth_{i}.test.ts\n\n"
            "Question: Did tests pass? Return PASS or FAIL, followed by failing test names if any."
        )
        uncached.append(chat(system, user, cache_prompt=False))
        print(f"uncached {i} {uncached[-1]}", flush=True)
    for i in range(8):
        user = (
            f"Command output:\n{40 + i} tests passed, {i % 2} failed\n"
            f"FAIL test/queue_{i}.test.ts\n\n"
            "Question: Did tests pass? Return PASS or FAIL, followed by failing test names if any."
        )
        cached.append(chat(system, user, cache_prompt=True))
        print(f"cached {i} {cached[-1]}", flush=True)

    def med(rows: list[dict], key: str, skip: int = 1) -> float | None:
        vals = [r[key] for r in rows[skip:] if r.get(key) is not None]
        return round(statistics.median(vals), 2) if vals else None

    before = pid_on_port(8009)
    if before:
        os.kill(before, 15)
        time.sleep(0.4)
        if pid_on_port(8009) == before:
            os.kill(before, 9)
            time.sleep(0.2)
    t0 = time.perf_counter()
    fallback = subprocess.run(
        ["bun", "run", str(CLI), "Did tests pass? Return PASS or FAIL."],
        cwd=ROOT,
        input="FAIL src/queue.test.ts\n",
        text=True,
        capture_output=True,
        env=env,
        timeout=120,
    )
    fallback_sec = round(time.perf_counter() - t0, 2)
    report = {
        "warmup_status": warmup.returncode,
        "uncached_prompt_ms_median": med(uncached, "prompt_ms"),
        "uncached_wall_ms_median": med(uncached, "wall_ms"),
        "cached_prompt_ms_median": med(cached, "prompt_ms"),
        "cached_wall_ms_median": med(cached, "wall_ms"),
        "cached_cache_n_median": med(cached, "cache_n", skip=0),
        "cached_prompt_n_median": med(cached, "prompt_n", skip=0),
        "fallback_sec": fallback_sec,
        "fallback_status": fallback.returncode,
        "fallback_pred": (fallback.stdout or "").strip()[:120],
        "fallback_restarted": pid_on_port(8009) not in (None, before),
        "uncached": uncached,
        "cached": cached,
    }
    u = report["uncached_prompt_ms_median"]
    c = report["cached_prompt_ms_median"]
    if u and c and u > 0:
        report["prompt_ms_ratio"] = round(c / u, 3)
        report["prompt_ms_drop_pct"] = round((1 - c / u) * 100, 1)
    OUT.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k not in ("uncached", "cached")}, indent=2))
    return 0 if fallback.returncode == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

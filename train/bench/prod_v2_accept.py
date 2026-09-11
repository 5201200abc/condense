#!/usr/bin/env python3
"""Run the frozen 6-task set through `bun src/cli.ts` (production local path)."""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LABELED = ROOT / "train/data/labeled"
PREV = ROOT / "train/bench/official_vs_distill2.json"
Q4_REF = ROOT / "train/bench/v2_f16_align.json"
OUT = ROOT / "train/bench/prod_v2_accept.json"
GGUF = ROOT / "train/gguf/v2/condense-0.8B-Q4_K_M.gguf"
CLI = ROOT / "src/cli.ts"
QUESTION_MARK = "\n\nQuestion: "


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    with path.open() as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def tasks() -> list[dict]:
    prev = json.loads(PREV.read_text())
    seen: set[str] = set()
    out = []
    for row in prev.get("results") or []:
        if row.get("model") != "distill2-0.6B" or row["id"] in seen:
            continue
        seen.add(row["id"])
        out.append(row)
    return out


def catalog() -> dict[str, dict]:
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


def split_user(user: str) -> tuple[str, str]:
    if QUESTION_MARK not in user:
        raise SystemExit("labeled user missing Question marker")
    body, question = user.rsplit(QUESTION_MARK, 1)
    prefix = "Command output:\n"
    output = body[len(prefix) :] if body.startswith(prefix) else body
    return output, question


def q4_ref() -> dict[str, str]:
    data = json.loads(Q4_REF.read_text())
    return {
        row["id"]: row["pred"]
        for row in data.get("results") or []
        if row.get("model") == "v2-q4-from-nop1-chat"
    }


def main() -> int:
    if not GGUF.is_file():
        raise SystemExit(f"missing {GGUF}")
    env = os.environ.copy()
    env["CONDENSE_LLAMA_GGUF"] = str(GGUF)
    env["CONDENSE_PROVIDER"] = "local"
    env["CONDENSE_LOCAL_BACKEND"] = "llamacpp"
    env["CONDENSE_AUTO_LEARN"] = "false"
    env["CONDENSE_DATASET_ENABLED"] = "false"
    env["CONDENSE_SHOW_STATS"] = "false"
    refs = q4_ref()
    cat = catalog()
    results = []
    matches = 0
    for task in tasks():
        src = cat[task["id"]]
        user = next(m["content"] for m in src["messages"] if m["role"] == "user")
        gold = next(m["content"] for m in src["messages"] if m["role"] == "assistant")
        output, question = split_user(user)
        t0 = time.perf_counter()
        proc = subprocess.run(
            ["bun", "run", str(CLI), question],
            cwd=ROOT,
            input=output,
            text=True,
            capture_output=True,
            env=env,
            timeout=120,
        )
        sec = round(time.perf_counter() - t0, 2)
        pred = (proc.stdout or "").strip()
        ref = refs.get(task["id"], "")
        same = pred == ref
        matches += int(same)
        results.append(
            {
                "id": task["id"],
                "task": task["task"],
                "gold": gold[:240],
                "pred": pred[:500],
                "ref": ref[:500],
                "match_q4": same,
                "sec": sec,
                "status": proc.returncode,
                "stderr_tail": (proc.stderr or "")[-200:],
            }
        )
        print(
            f"{task['task']} match={same} {sec}s status={proc.returncode} "
            f"{pred[:120].replace(chr(10), ' / ')}",
            flush=True,
        )
        if proc.returncode != 0:
            print(proc.stderr[-400:], flush=True)
    report = {
        "n": len(results),
        "matches": matches,
        "gguf": str(GGUF),
        "results": results,
    }
    OUT.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"n": len(results), "matches": matches}, indent=2))
    return 0 if matches == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())

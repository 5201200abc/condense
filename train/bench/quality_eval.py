#!/usr/bin/env python3
"""Held-out quality eval: distill2 vs v2 Q4 on the same compact-system inputs."""

from __future__ import annotations

import argparse
import json
import re
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VALID = ROOT / "train/data/labeled/valid.jsonl"
V2_TRAIN = ROOT / "train/data/v2/train.jsonl"
SET_PATH = ROOT / "train/bench/quality_eval.jsonl"
PRED_PATH = ROOT / "train/bench/quality_eval_preds.json"
REPORT_PATH = ROOT / "train/bench/quality_eval_report.json"
MIXED_PASS_FAIL_PATH = ROOT / "train/bench/mixed_pass_fail_regressions.jsonl"
MAX_INPUT = 8000
INSUFF = "condense: Insufficient information to output anything."
VERDICTS = ("PASS", "FAIL", "SAFE", "REVIEW", "UNSAFE", "NONE")
CVE_RE = re.compile(r"CVE-\d{4}-\d+", re.I)
PATH_RE = re.compile(r"(?:[\w./\-]+)\.(?:ts|tsx|js|jsx|mjs|cjs|json|go|py|tf|yml|yaml|md)", re.I)
HASH_RE = re.compile(r"\b[0-9a-f]{7,40}\b")
PKG_RE = re.compile(r'"package"\s*:\s*"([^"]+)"')


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    with path.open() as fh:
        for line in fh:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def with_required_regressions(rows: list[dict]) -> list[dict]:
    required = load_jsonl(MIXED_PASS_FAIL_PATH)
    required_ids = {row["id"] for row in required}
    return [row for row in rows if row.get("id") not in required_ids] + required


def compact_system() -> str:
    return next(
        m["content"]
        for m in load_jsonl(V2_TRAIN)[0]["messages"]
        if m["role"] == "system"
    )


def fit_input(text: str, max_chars: int = MAX_INPUT) -> str:
    if len(text) <= max_chars:
        return text
    half = max_chars // 2 - 50
    dropped = len(text) - 2 * half
    return f"{text[:half]}\n... [{dropped} chars truncated] ...\n{text[-half:]}"


def split_user(user: str) -> tuple[str, str]:
    marker = "\n\nQuestion: "
    if marker not in user:
        return user, ""
    body, question = user.rsplit(marker, 1)
    prefix = "Command output:\n"
    output = body[len(prefix) :] if body.startswith(prefix) else body
    return output, question


def tag_row(user: str, gold: str, task: str) -> list[str]:
    tags = [task]
    output, question = split_user(user)
    low = output.lower()
    q = question.lower()
    g = gold.strip()
    if g == "NONE" or g.startswith(INSUFF) or g in ("[]", "{}"):
        tags.append("empty")
    if output.count("error TS") >= 2 or "typescript" in task:
        tags.append("ts")
        if output.count("error TS") >= 2:
            tags.append("ts_multi")
    if output.count("error TS") >= 2 or len(re.findall(r"\berror\b", low)) >= 3:
        tags.append("multi_error")
    if task == "terraform_plan" or "terraform" in q or "safe" in q:
        tags.append("terraform")
    if task == "security_audit" or "json" in q or "vulnerab" in q:
        tags.append("audit")
    if len(user) > 4000:
        tags.append("long")
    if (re.search(r"\bpass\b", low) and re.search(r"\bfail\b", low)) or (
        "destroy" in low and "create" in low
    ) or ("error" in low and "exit 0" in low):
        tags.append("contradiction")
    return sorted(set(tags))


def build_set() -> list[dict]:
    rows = []
    for raw in load_jsonl(VALID):
        msgs = {m["role"]: m["content"] for m in raw["messages"]}
        meta = raw.get("metadata") or {}
        user, gold = msgs["user"], msgs["assistant"]
        output, question = split_user(user)
        rows.append(
            {
                "id": meta.get("id"),
                "task": meta.get("task"),
                "source_hash": meta.get("source_hash"),
                "question": question,
                "output": output,
                "gold": gold,
                "tags": tag_row(user, gold, meta.get("task") or "generic"),
            }
        )
    rows = with_required_regressions(rows)
    SET_PATH.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
    return rows


def strip_think(text: str) -> str:
    t = text.strip()
    if "</think>" in t:
        t = t.split("</think>")[-1].strip()
    t = t.replace("<|im_end|>", "").strip()
    return t


def first_verdict(text: str) -> str | None:
    t = strip_think(text)
    if t.startswith(INSUFF) or INSUFF in t[:80]:
        return "INSUFF"
    token = re.split(r"[\s:.\-]+", t, maxsplit=1)[0].upper() if t else ""
    return token if token in VERDICTS else None


def identifiers(text: str) -> set[str]:
    found = set()
    for m in CVE_RE.findall(text):
        found.add(m.upper())
    for m in PATH_RE.findall(text):
        found.add(Path(m).name.lower())
    for m in HASH_RE.findall(text.lower()):
        if len(m) >= 7:
            found.add(m[:7])
    for m in PKG_RE.findall(text):
        found.add(m.lower())
    return {x for x in found if x not in {"json", "true", "false"}}


def tokens(text: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9_./:-]{2,}", strip_think(text).lower()) if t}


def f1(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    inter = len(a & b)
    if inter == 0:
        return 0.0
    p = inter / len(a)
    r = inter / len(b)
    return 2 * p * r / (p + r)


def format_ok(question: str, pred: str) -> bool:
    raw = pred.strip()
    if "<|im_end|>" in raw:
        return False
    if "<think>" in raw.lower() or "</think>" in raw.lower():
        return False
    head = strip_think(raw)[:48].lower()
    if head.startswith(("okay", "ok,", "first,", "here is", "sure,")):
        return False
    body = strip_think(raw)
    q = question.lower()
    if "json" in q:
        try:
            json.loads(body)
            return True
        except json.JSONDecodeError:
            return False
    if any(k in q for k in ("pass or fail", "return pass", "return only pass", "did the", "succeed")):
        v = first_verdict(raw)
        return v in {"PASS", "FAIL", "INSUFF", "NONE", "SAFE", "REVIEW", "UNSAFE"}
    if "safe" in q and any(k in q for k in ("safe", "review", "unsafe")):
        return first_verdict(raw) in {"SAFE", "REVIEW", "UNSAFE", "INSUFF"}
    if "one per line" in q or "return only those paths" in q or "list " in q:
        if body.startswith(("- ", "* ", "1.")):
            return False
    return bool(body)


def score_one(question: str, source: str, gold: str, pred: str) -> dict:
    body = strip_think(pred)
    gv = first_verdict(gold)
    pv = first_verdict(pred)
    src_ids = identifiers(source)
    gold_ids = identifiers(gold)
    pred_ids = identifiers(pred)
    extra = pred_ids - src_ids - gold_ids
    missing = gold_ids - pred_ids if gv != "INSUFF" else set()
    gold_ins = gold.strip().startswith(INSUFF) or gold.strip() == "NONE"
    pred_ins = pv in {"INSUFF", "NONE"} or body.startswith(INSUFF)
    hallu = bool(extra)
    if gold_ins and pv in {"FAIL", "PASS", "UNSAFE", "SAFE"} and extra:
        hallu = True
    if gold_ins and not pred_ins and pv in {"FAIL", "UNSAFE"}:
        hallu = True
    miss = bool(missing)
    if gv in VERDICTS and pv in VERDICTS and gv != pv:
        miss = True
    if gv == "UNSAFE" and pv == "SAFE":
        miss = True
    if gold_ins:
        correct = pred_ins
    elif gv and pv:
        correct = gv == pv and not hallu
    else:
        correct = f1(tokens(body), tokens(gold)) >= 0.4 and not hallu
    return {
        "correct": correct,
        "miss": miss,
        "hallucination": hallu,
        "format_ok": format_ok(question, pred),
        "gold_verdict": gv,
        "pred_verdict": pv,
        "extra_ids": sorted(extra)[:8],
        "missing_ids": sorted(missing)[:8],
        "token_f1": round(f1(tokens(body), tokens(gold)), 3),
    }


def post_chat(host: str, model: str, system: str, user: str, timeout: float, max_tokens: int) -> dict:
    req = urllib.request.Request(
        host.rstrip("/") + "/v1/chat/completions",
        data=json.dumps(
            {
                "model": model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "temperature": 0,
                "max_tokens": max_tokens,
                "cache_prompt": True,
                "chat_template_kwargs": {"enable_thinking": False},
            }
        ).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            payload = json.loads(res.read().decode())
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        return {"pred": "", "error": f"HTTP {exc.code}: {raw[:240]}", "sec": round(time.perf_counter() - t0, 2)}
    except Exception as exc:  # noqa: BLE001
        return {"pred": "", "error": str(exc)[:240], "sec": round(time.perf_counter() - t0, 2)}
    choices = payload.get("choices") or []
    msg = (choices[0].get("message") or {}) if choices else {}
    pred = (msg.get("content") or "").strip()
    return {"pred": pred, "error": None, "sec": round(time.perf_counter() - t0, 2)}


def run_backend(name: str, host: str, model: str, rows: list[dict], system: str, max_tokens: int, timeout: float) -> list[dict]:
    out = []
    for i, row in enumerate(rows, 1):
        user = f"Command output:\n{fit_input(row['output'])}\n\nQuestion: {row['question']}"
        rec = post_chat(host, model, system, user, timeout, max_tokens)
        scored = score_one(row["question"], row["output"], row["gold"], rec["pred"])
        item = {
            "model": name,
            "id": row["id"],
            "task": row["task"],
            "tags": row["tags"],
            "gold": row["gold"][:240],
            "pred": rec["pred"][:500],
            "error": rec["error"],
            "sec": rec["sec"],
            **scored,
        }
        out.append(item)
        mark = "ok" if scored["correct"] else "miss" if scored["miss"] else "no"
        print(
            f"{name} {i:3d}/{len(rows)} {row['task']} {mark} fmt={int(scored['format_ok'])} "
            f"h={int(scored['hallucination'])} {rec['sec']}s {strip_think(rec['pred'])[:90].replace(chr(10),' / ')}",
            flush=True,
        )
    return out


def summarize(rows: list[dict]) -> dict:
    by_tag: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        for tag in r.get("tags") or [r.get("task")]:
            by_tag[str(tag)].append(r)
    def rates(rs: list[dict]) -> dict:
        m = len(rs) or 1
        return {
            "n": len(rs),
            "accuracy": round(sum(r["correct"] for r in rs) / m, 3),
            "miss_rate": round(sum(r["miss"] for r in rs) / m, 3),
            "hallucination_rate": round(sum(r["hallucination"] for r in rs) / m, 3),
            "format_ok": round(sum(r["format_ok"] for r in rs) / m, 3),
        }
    served = [r for r in rows if not r.get("error")]
    ctx_overflow = sum(
        1 for r in rows if r.get("error") and "exceed_context_size_error" in str(r.get("error"))
    )
    return {
        "overall": rates(rows),
        "served": rates(served),
        "by_task": {k: rates(v) for k, v in sorted(by_tag.items()) if k in {
            "terraform_plan", "security_audit", "typescript_check", "pass_fail",
            "docker_k8s", "generic", "test_result", "empty", "ts_multi", "long",
            "contradiction", "terraform", "audit", "ts", "multi_error",
            "mixed_pass_fail", "production_regression", "required_variant",
        }},
        "errors": sum(1 for r in rows if r.get("error")),
        "ctx_overflow": ctx_overflow,
    }


def decide(report: dict) -> dict:
    v2 = report["v2"]["overall"]
    d2 = report["distill2"]["overall"]
    v2s = report["v2"].get("served") or v2
    d2s = report["distill2"].get("served") or d2
    weak = []
    for slice_name in ("terraform", "terraform_plan", "audit", "security_audit"):
        a = report["v2"]["by_task"].get(slice_name)
        b = report["distill2"]["by_task"].get(slice_name)
        if a and b and a["accuracy"] + 0.05 < b["accuracy"]:
            weak.append({"slice": slice_name, "v2": a["accuracy"], "distill2": b["accuracy"]})
    format_ok = v2["format_ok"] >= d2["format_ok"] or v2s["format_ok"] >= d2s["format_ok"]
    mixed_pass_fail = report["v2"]["by_task"].get("mixed_pass_fail")
    mixed_pass_fail_gate = bool(
        mixed_pass_fail
        and mixed_pass_fail["n"] > 0
        and mixed_pass_fail["accuracy"] == 1.0
        and mixed_pass_fail["miss_rate"] == 0.0
    )
    v2_better = (
        v2["accuracy"] >= d2["accuracy"]
        and v2["hallucination_rate"] <= d2["hallucination_rate"] + 0.02
        and format_ok
    )
    ship_v2 = (
        v2_better
        and v2s["format_ok"] >= 0.8
        and v2["hallucination_rate"] <= 0.35
        and mixed_pass_fail_gate
    )
    if not mixed_pass_fail_gate:
        rec = "do_not_ship_yet"
    elif v2_better and not weak:
        rec = "ship_v2"
    elif v2_better and weak:
        rec = "ship_v2_then_targeted_v3"
    else:
        rec = "do_not_ship_yet"
    return {
        "v2_better_overall": v2_better,
        "weak_slices": weak,
        "recommendation": rec,
        "ship_v2": ship_v2,
        "quality_gates": {
            "mixed_pass_fail": {
                "required": True,
                "passed": mixed_pass_fail_gate,
                "rule": "explicit failed test or `error: test failed` must produce FAIL, never PASS",
                "metrics": mixed_pass_fail,
            }
        },
        "note": (
            "Format-all can be pulled down by llama.cpp slot overflows "
            "(--ctx-size 20480 / --parallel 5 = 4096 tokens). Decision uses "
            "overall accuracy/hallucination and served format."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", choices=("v2", "distill2"))
    parser.add_argument("--host")
    parser.add_argument("--model")
    parser.add_argument("--max-tokens", type=int, default=512)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--rebuild-set", action="store_true")
    parser.add_argument("--from-preds", action="store_true", help="Rescore existing preds only")
    args = parser.parse_args()

    rows = (
        build_set()
        if args.rebuild_set or not SET_PATH.exists()
        else with_required_regressions(load_jsonl(SET_PATH))
    )
    if args.from_preds:
        all_preds = json.loads(PRED_PATH.read_text()).get("results") or []
    else:
        if not args.backend or not args.host or not args.model:
            parser.error("--backend, --host, and --model are required unless --from-preds")
        system = compact_system()
        preds = run_backend(args.backend, args.host, args.model, rows, system, args.max_tokens, args.timeout)
        blob = {"results": preds}
        if PRED_PATH.exists():
            prev = json.loads(PRED_PATH.read_text())
            prev.setdefault("results", [])
            prev["results"] = [r for r in prev["results"] if r.get("model") != args.backend] + preds
            PRED_PATH.write_text(json.dumps(prev, indent=2) + "\n")
            all_preds = prev["results"]
        else:
            PRED_PATH.write_text(json.dumps(blob, indent=2) + "\n")
            all_preds = preds

    grouped = defaultdict(list)
    for r in all_preds:
        grouped[r["model"]].append(r)
    report = {name: summarize(rs) for name, rs in grouped.items()}
    if "v2" in report and "distill2" in report:
        report["decision"] = decide(report)
        report["counts"] = dict(Counter(row["task"] for row in rows))
        report["n"] = len(rows)
        report["coverage"] = json.loads((ROOT / "train/bench/quality_eval_coverage.json").read_text()) if (ROOT / "train/bench/quality_eval_coverage.json").exists() else None
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: v if k != "decision" else v for k, v in report.items()}, indent=2)[:4000])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

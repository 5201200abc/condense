#!/usr/bin/env python3
"""Extract Condense (question, input) pairs and relabel completions with a teacher."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

INSUFFICIENT = "condense: Insufficient information to output anything."
NONE = "NONE"
QUESTION_MARK = "\nQUESTION:\n"
INPUT_MARK = "\nINPUT:\n"


def parse_capture(record: dict) -> dict | None:
    prompt = str(record.get("prompt") or "")
    meta = record.get("metadata") if isinstance(record.get("metadata"), dict) else {}
    if QUESTION_MARK in prompt and INPUT_MARK in prompt:
        rest = prompt.split(QUESTION_MARK, 1)[1]
        question, raw_input = rest.split(INPUT_MARK, 1)
        return {
            "question": question.strip(),
            "input": raw_input.strip(),
            "task": meta.get("task") or "generic",
            "source": meta.get("source") or "condense",
        }
    if record.get("question") and record.get("input") is not None:
        return {
            "question": str(record["question"]).strip(),
            "input": str(record["input"]).strip(),
            "task": record.get("task") or meta.get("task") or "generic",
            "source": record.get("source") or meta.get("source") or "pair",
        }
    return None


def pair_id(question: str, raw_input: str) -> str:
    return hashlib.sha256(f"{question}\n{raw_input}".encode("utf-8")).hexdigest()[:16]


def source_hash(raw_input: str) -> str:
    return hashlib.sha256(raw_input.encode("utf-8")).hexdigest()[:16]


def attach_ids(pair: dict) -> dict:
    pair["id"] = pair_id(pair["question"], pair["input"])
    pair["source_hash"] = source_hash(pair["input"])
    return pair


def usable_pair(pair: dict) -> str | None:
    if len(pair["input"]) < 20:
        return "input too short"
    if len(pair["input"]) > 24_000:
        return "input too long"
    if not pair["question"]:
        return "missing question"
    return None


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    if not path.exists():
        return rows
    for line in path.read_text().splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows))


def append_jsonl(path: Path, row: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def extract_pairs(raw_paths: list[Path]) -> list[dict]:
    seen: set[str] = set()
    pairs: list[dict] = []
    for path in raw_paths:
        for record in load_jsonl(path):
            pair = parse_capture(record)
            if pair is None:
                continue
            reason = usable_pair(pair)
            if reason:
                continue
            attach_ids(pair)
            if pair["id"] in seen:
                continue
            seen.add(pair["id"])
            pairs.append(pair)
    return pairs


def user_content(question: str, raw_input: str) -> str:
    return f"Command output:\n{raw_input}\n\nQuestion: {question}"


def input_from_user(user: str) -> str:
    prefix = "Command output:\n"
    mark = "\n\nQuestion: "
    if user.startswith(prefix) and mark in user:
        return user[len(prefix) :].rsplit(mark, 1)[0]
    return user


def labeled_source_hash(row: dict) -> str:
    meta = row.get("metadata") or {}
    if meta.get("source_hash"):
        return str(meta["source_hash"])
    user = next((msg.get("content") or "" for msg in row.get("messages") or [] if msg.get("role") == "user"), "")
    return source_hash(input_from_user(user))


def ensure_source_hash(row: dict) -> dict:
    meta = dict(row.get("metadata") or {})
    if not meta.get("source_hash"):
        meta["source_hash"] = labeled_source_hash(row)
        row = {**row, "metadata": meta}
    return row


def _has(text: str, *pats: str) -> bool:
    return any(re.search(pat, text, re.I | re.M) for pat in pats)


def asks_pass_fail_token(question: str) -> bool:
    if re.search(r"if none,?\s+return PASS", question, re.I):
        return False
    return bool(re.search(r"PASS or FAIL|Did .+ pass\?|Is the working tree clean\?", question, re.I))


def has_positive_evidence(question: str, raw_input: str) -> bool:
    """True only when the log actually contains facts that answer the question."""
    q = question.lower()
    t = raw_input
    fetch_error = _has(t, r"http 404", r"could not resolve", r"failed to get runs", r"not found \(")

    if re.search(r"\b(pass|fail)\b", q) and not re.search(r"\b(safe|unsafe|review)\b", q):
        if re.search(r"container|pods?|running status", q):
            return _has(
                t,
                r"\b(up |running|exited|created|paused|dead|restarting)\b",
                r"crashloopbackoff|imagepullbackoff",
                r"READY\s+STATUS",
            )
        if re.search(r"\bci\b|workflow|github actions", q):
            if fetch_error:
                return False
            return _has(
                t,
                r'"conclusion":\s*"(success|failure|cancelled)"',
                r"\b(success|failure|cancelled)\b",
                r"^X ",
                r"✓ ",
            )
        if re.search(r"\btests?\b", q):
            return _has(
                t,
                r"\d+\s+(pass|fail|passed|failed)\b",
                r"\((pass|fail)\)",
                r"tests? (passed|failed)",
                r"error ts\d+",
            )
        if fetch_error and not _has(t, r"\d+\s+(pass|fail)", r"\((pass|fail)\)"):
            return False
        return _has(t, r"\bexit\s+\d+", r"\berror\b", r"\bsuccess", r"\bfail", r"\bok\b")

    if re.search(r"\b(safe|unsafe|review)\b", q):
        return _has(t, r"plan:", r"will be created", r"will be destroyed", r"#\s+\S+\s+will be", r"force_destroy")

    if re.search(r"resource", q) and re.search(r"creat|destroy", q):
        return _has(t, r"will be created", r"will be destroyed", r"will be updated", r"plan:\s*\d+", r"#\s+\S+\s+will be")

    if "package" in q:
        tree = re.findall(r"[├└]──[^\n]+", t)
        installed = [line for line in tree if "UNMET DEPENDENCY" not in line]
        if installed:
            return True
        return bool(tree) is False and _has(t, r"@\d+\.\d+") and "UNMET DEPENDENCY" not in t

    if re.search(r"workflow|github actions|list the latest", q) or ("run" in q and "list" in q):
        if fetch_error:
            return False
        return _has(t, r"\b(completed|success|failure|cancelled|in_progress|queued)\b")

    if "pull request" in q:
        if fetch_error or _has(t, r"could not resolve"):
            return False
        return _has(t, r"#\d+")

    if re.search(r"what changed|files changed|modified files|untracked|dirty path", q):
        return _has(t, r"^\s*[MADRC?]{1,2}\s+\S", r"\S+\s+\|\s+\d+", r"\d+ files? changed", r"^diff --git", r"^@@ ")

    if re.search(r"vulnerabilit|audit|cve|high or critical", q):
        return _has(t, r"vulnerabilit", r"severity", r"cve-", r"found 0")

    return False


def is_path_list_question(question: str) -> bool:
    q = question.lower()
    if not re.search(r"\b(paths?|filenames?|files?)\b", q):
        return False
    return bool(re.search(r"return only|one per line|list ", q, re.I))


def path_exts_for_question(question: str) -> tuple[str, ...]:
    q = question.lower()
    if re.search(r"typescript|\.tsx?\b|\.mts\b|\.cts\b", q):
        return (".ts", ".tsx", ".mts", ".cts")
    return ()


def input_has_matching_paths(question: str, raw_input: str) -> bool:
    exts = path_exts_for_question(question)
    if not exts:
        return bool(re.search(r"(?:^|[\s/`])[\w./-]+\.\w{1,8}\b", raw_input, re.M))
    pat = r"(?:^|[\s/`])(?:[\w.-]+/)*[\w.-]+(?:" + "|".join(re.escape(ext) for ext in exts) + r")\b"
    return bool(re.search(pat, raw_input, re.I | re.M))


def is_zero_match_path_list(question: str, raw_input: str) -> bool:
    return is_path_list_question(question) and not input_has_matching_paths(question, raw_input)


def normalize_completion(question: str, raw_input: str, completion: str | None) -> str:
    text = (completion or "").strip()
    if not text and is_zero_match_path_list(question, raw_input):
        return NONE
    return text


def is_list_question(question: str) -> bool:
    return bool(
        re.search(
            r"(one per line|list |return only|json only|files changed|one-line summary)",
            question,
            re.I,
        )
    )


def is_compact_listing(raw_input: str) -> bool:
    if _has(raw_input, r"\d+ files? changed") and _has(raw_input, r"\|\s+\d+"):
        return True
    lines = [
        line.strip()
        for line in raw_input.splitlines()
        if line.strip() and not re.match(r"^exit \d+$", line.strip())
    ]
    if not lines or len(raw_input) > 2048:
        return False
    oneline = sum(1 for line in lines if re.match(r"^[0-9a-f]{7,}\s+\S", line))
    if oneline >= max(2, len(lines) - 1):
        return True
    piped = sum(1 for line in lines if " | " in line or re.search(r"\|\s+\d+", line))
    return piped >= max(2, len(lines) // 2)


def looks_bad(question: str, raw_input: str, completion: str) -> str | None:
    text = completion.strip()
    if not text:
        return "empty"
    lower = text.lower()
    if "please provide" in lower or "here is" in lower:
        return "preamble"
    if text == NONE:
        if is_zero_match_path_list(question, raw_input):
            return None
        return "false NONE"
    if text == INSUFFICIENT:
        if has_positive_evidence(question, raw_input):
            return "false insufficient"
        return None
    if asks_pass_fail_token(question):
        if not re.match(r"^(PASS|FAIL)\b", text):
            return "missing PASS/FAIL"
    if re.search(r"\b(safe|unsafe|review)\b", question, re.I):
        if not re.match(r"^(SAFE|REVIEW|UNSAFE)\b", text):
            return "missing SAFE/REVIEW/UNSAFE"
    if (
        len(raw_input) < 1024
        and len(text) > len(raw_input) + 80
        and not text.startswith(("{", "["))
        and not is_list_question(question)
        and not is_compact_listing(raw_input)
    ):
        return "longer than source"
    return None


def split_by_source(
    labeled: list[dict], valid_frac: float = 0.1, seed: int = 0
) -> tuple[list[dict], list[dict]]:
    """Keep every pair from the same original log in one split."""
    groups: dict[str, list[dict]] = {}
    for row in labeled:
        groups.setdefault(labeled_source_hash(row), []).append(row)
    keys = sorted(groups)
    rng = random.Random(seed)
    rng.shuffle(keys)
    total = len(labeled)
    if total == 0:
        return [], []
    if len(keys) == 1:
        return list(labeled), []
    target = max(1, round(total * valid_frac))
    valid: list[dict] = []
    train: list[dict] = []
    remaining_items = total
    for key in keys:
        group = groups[key]
        remaining_items -= len(group)
        if len(valid) < target and remaining_items > 0:
            valid.extend(group)
        else:
            train.extend(group)
    if not train:
        return valid, []
    return train, valid


def chat_completion(host: str, model: str, api_key: str, system: str, user: str, timeout: float) -> str:
    url = host.rstrip("/") + "/chat/completions"
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0,
        "max_tokens": 512,
    }
    last_error: Exception | None = None
    for attempt in range(3):
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "content-type": "application/json",
                **({"authorization": f"Bearer {api_key}"} if api_key else {}),
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                payload = json.loads(res.read().decode("utf-8"))
            content = (
                (((payload.get("choices") or [{}])[0].get("message") or {}).get("content") or "")
                .strip()
            )
            return content
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")[:300]
            last_error = RuntimeError(f"HTTP {exc.code}: {raw}")
            if exc.code in {404, 429, 500, 502, 503} and attempt < 2:
                continue
            raise last_error from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt < 2:
                continue
            raise
    raise last_error or RuntimeError("teacher request failed")


def cmd_extract(args: argparse.Namespace) -> int:
    raw_paths = list(args.raw)
    if args.raw_dir:
        raw_paths.extend(sorted(Path(args.raw_dir).glob("*.jsonl")))
    pairs = extract_pairs(raw_paths)
    write_jsonl(args.out, pairs)
    print(f"wrote {len(pairs)} pairs to {args.out}")
    return 0


def cmd_capture(args: argparse.Namespace) -> int:
    raw_input = sys.stdin.read()
    pair = attach_ids(
        {
            "question": args.question.strip(),
            "input": raw_input.strip(),
            "task": args.task,
            "source": "cmd",
        }
    )
    reason = usable_pair(pair)
    if reason:
        print(reason, file=sys.stderr)
        return 1
    rows = load_jsonl(args.out)
    ids = {row.get("id") for row in rows}
    if pair["id"] not in ids:
        rows.append(pair)
        write_jsonl(args.out, rows)
    print(f"captured {pair['id']} n={len(rows)}")
    return 0


def load_labeled(out_dir: Path) -> list[dict]:
    rows: list[dict] = []
    have: set[str] = set()
    for path in (out_dir / "train.jsonl", out_dir / "valid.jsonl", out_dir / "accepted.jsonl"):
        for row in load_jsonl(path):
            row = ensure_source_hash(row)
            pid = (row.get("metadata") or {}).get("id")
            if pid in have:
                continue
            have.add(pid)
            rows.append(row)
    return rows


def materialize_retry_row(row: dict, pairs_by_id: dict[str, dict]) -> dict | None:
    full = dict(pairs_by_id.get(row.get("id") or "") or {})
    question = row.get("question") or full.get("question")
    raw = row.get("input") if row.get("input") is not None else full.get("input")
    if not question or raw is None:
        return None
    pair = {
        "question": str(question).strip(),
        "input": str(raw).strip(),
        "task": row.get("task") or full.get("task") or "generic",
        "source": full.get("source") or row.get("source") or "retry",
    }
    attach_ids(pair)
    if row.get("id"):
        pair["id"] = row["id"]
    if row.get("reason"):
        pair["retry_reason"] = row["reason"]
    return pair


def write_retry_queue(path: Path, rejected: list[dict], pairs: list[dict]) -> int:
    by_id = {str(pair.get("id")): pair for pair in pairs if pair.get("id")}
    out: list[dict] = []
    seen: set[str] = set()
    for row in rejected:
        pid = row.get("id")
        if not pid or pid in seen:
            continue
        rec = materialize_retry_row(row, by_id)
        if rec is None:
            continue
        seen.add(pid)
        out.append(rec)
    write_jsonl(path, out)
    return len(out)


def reject_record(pair: dict, reason: str, completion: str = "") -> dict:
    rec = {
        "id": pair.get("id"),
        "reason": reason,
        "task": pair.get("task"),
        "question": pair.get("question"),
        "input": pair.get("input"),
        "source": pair.get("source"),
        "source_hash": pair.get("source_hash") or source_hash(pair.get("input") or ""),
    }
    if completion:
        rec["completion"] = completion
    return rec


def write_splits(out_dir: Path, labeled: list[dict], rejected: list[dict], pairs: list[dict], seed: int) -> None:
    labeled = [ensure_source_hash(row) for row in labeled]
    train, valid = split_by_source(labeled, seed=seed)
    out_dir.mkdir(parents=True, exist_ok=True)
    write_jsonl(out_dir / "train.jsonl", train)
    write_jsonl(out_dir / "valid.jsonl", valid)
    write_jsonl(out_dir / "accepted.jsonl", labeled)
    write_jsonl(out_dir / "rejected.jsonl", rejected)
    pair_by_id = {pair.get("id"): pair for pair in pairs}
    review = []
    for row in labeled:
        pid = (row.get("metadata") or {}).get("id")
        pair = pair_by_id.get(pid) or {}
        completion = next(
            (msg["content"] for msg in row["messages"] if msg.get("role") == "assistant"),
            "",
        )
        review.append(
            {
                "id": pid,
                "task": (row.get("metadata") or {}).get("task") or pair.get("task"),
                "source_hash": (row.get("metadata") or {}).get("source_hash") or pair.get("source_hash"),
                "question": pair.get("question"),
                "input_tail": (pair.get("input") or "")[-240:],
                "completion": completion,
                "teacher": (row.get("metadata") or {}).get("teacher"),
            }
        )
    (out_dir / "review.json").write_text(json.dumps(review, ensure_ascii=False, indent=2) + "\n")
    train_h = {labeled_source_hash(row) for row in train}
    valid_h = {labeled_source_hash(row) for row in valid}
    overlap = train_h & valid_h
    print(
        f"labeled {len(labeled)} rejected {len(rejected)} "
        f"train {len(train)} valid {len(valid)} "
        f"sources train {len(train_h)} valid {len(valid_h)} overlap {len(overlap)}"
    )
    if overlap:
        raise RuntimeError(f"source hash leakage: {sorted(overlap)[:8]}")


def cmd_retry_sync(args: argparse.Namespace) -> int:
    pairs = load_jsonl(args.pairs)
    rejected = load_jsonl(args.out_dir / "rejected.jsonl")
    n = write_retry_queue(args.out_dir / "retry.jsonl", rejected, pairs)
    print(f"retry queue {n} from {len(rejected)} rejected -> {args.out_dir / 'retry.jsonl'}")
    missing = [row.get("id") for row in rejected if row.get("id") and not any(p.get("id") == row.get("id") for p in pairs)]
    if missing:
        print(f"unmatched rejected ids {len(missing)}: {missing[:8]}")
    return 0 if n else 1


def cmd_label(args: argparse.Namespace) -> int:
    system = Path(args.system_file).read_text()
    pairs = load_jsonl(args.pairs)
    retry_path = args.out_dir / "retry.jsonl"
    retry_pairs = [] if args.fresh else load_jsonl(retry_path)
    ordered: list[dict] = []
    seen_ids: set[str] = set()
    for pair in retry_pairs + pairs:
        if not pair.get("source_hash") and pair.get("input") is not None:
            pair["source_hash"] = source_hash(pair["input"])
        pid = pair.get("id")
        if not pid or pid in seen_ids:
            continue
        seen_ids.add(pid)
        ordered.append(pair)
    if args.retry_only:
        ordered = [pair for pair in ordered if any(r.get("id") == pair.get("id") for r in retry_pairs)]
        reason_by_id = {
            str(row.get("id")): str(row.get("retry_reason") or row.get("reason") or "")
            for row in retry_pairs
        }

        def retry_rank(pair: dict) -> int:
            reason = reason_by_id.get(str(pair.get("id")), "")
            if "429" in reason or "usage_limit" in reason:
                return 0
            if "false NONE" in reason:
                return 2
            return 1

        ordered.sort(key=retry_rank)
    pairs = ordered
    host = args.host or os.environ.get("TEACHER_HOST") or os.environ.get("CONDENSE_HOST")
    model = args.model or os.environ.get("TEACHER_MODEL") or os.environ.get("CONDENSE_MODEL")
    api_key = os.environ.get("TEACHER_API_KEY") or os.environ.get("CONDENSE_API_KEY") or ""
    if args.dry_run:
        print(f"dry-run {len(pairs)} pairs from {args.pairs}")
        return 0
    if not host or not model:
        print("set TEACHER_HOST and TEACHER_MODEL (OpenAI-compatible /v1)", file=sys.stderr)
        print(f"pairs ready: {len(pairs)} in {args.pairs}")
        return 2

    existing = [] if args.fresh else load_labeled(args.out_dir)
    have = {(row.get("metadata") or {}).get("id") for row in existing}
    labeled = list(existing)
    old_rejected = [] if args.fresh else load_jsonl(args.out_dir / "rejected.jsonl")
    rejected: list[dict] = []
    args.out_dir.mkdir(parents=True, exist_ok=True)
    accepted_path = args.out_dir / "accepted.jsonl"
    if args.fresh and accepted_path.exists():
        accepted_path.unlink()
    elif not accepted_path.exists() and labeled:
        write_jsonl(accepted_path, labeled)
    for pair in pairs:
        if args.stop_at and len(labeled) >= args.stop_at:
            print(f"stop-at {args.stop_at} accepted {len(labeled)}", file=sys.stderr)
            break
        if pair.get("id") in have:
            continue
        user = user_content(pair["question"], pair["input"])
        try:
            completion = chat_completion(host, model, api_key, system, user, args.timeout)
        except (urllib.error.URLError, RuntimeError, TimeoutError, json.JSONDecodeError) as exc:
            print(f"skip {pair['id']}: {exc}", file=sys.stderr)
            rec = reject_record(pair, f"request: {exc}")
            rejected.append(rec)
            append_jsonl(args.out_dir / "rejected.jsonl", rec)
            continue
        completion = normalize_completion(pair["question"], pair["input"], completion)
        if not completion:
            print(f"skip {pair['id']}: teacher returned empty completion", file=sys.stderr)
            rec = reject_record(pair, "request: teacher returned empty completion")
            rejected.append(rec)
            append_jsonl(args.out_dir / "rejected.jsonl", rec)
            continue
        reason = looks_bad(pair["question"], pair["input"], completion)
        if reason:
            print(f"reject {pair['id']}: {reason}", file=sys.stderr)
            rec = reject_record(pair, reason, completion)
            rejected.append(rec)
            append_jsonl(args.out_dir / "rejected.jsonl", rec)
            continue
        row = {
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
                {"role": "assistant", "content": completion},
            ],
            "metadata": {
                "id": pair["id"],
                "task": pair.get("task"),
                "source": pair.get("source"),
                "source_hash": pair.get("source_hash") or source_hash(pair["input"]),
                "teacher": model,
            },
        }
        labeled.append(row)
        have.add(pair["id"])
        append_jsonl(accepted_path, row)
        print(f"accept {pair['id']} n={len(labeled)}", file=sys.stderr)

    accepted_ids = {(row.get("metadata") or {}).get("id") for row in labeled}
    kept_old = [row for row in old_rejected if row.get("id") not in accepted_ids]
    kept_ids = {row.get("id") for row in kept_old}
    rejected = kept_old + [row for row in rejected if row.get("id") not in kept_ids]
    write_splits(args.out_dir, labeled, rejected, pairs, args.seed)
    n_retry = write_retry_queue(retry_path, rejected, pairs)
    print(f"retry queue {n_retry}")
    return 0 if labeled else 1


def cmd_self_test() -> int:
    capture = {
        "prompt": "contract\n\nTASK:\npass_fail\n\nQUESTION:\nDid tests pass? Return PASS or FAIL.\n\nINPUT:\nbun test\n1 failed auth.test.ts\n",
        "completion": "FAIL",
        "metadata": {"source": "condense", "task": "pass_fail"},
    }
    pair = parse_capture(capture)
    assert pair is not None
    assert pair["question"].startswith("Did tests pass?")
    assert "auth.test.ts" in pair["input"]
    assert usable_pair(pair) is None
    assert looks_bad(pair["question"], pair["input"], "maybe") == "missing PASS/FAIL"
    assert looks_bad(pair["question"], pair["input"], "FAIL auth.test.ts") is None

    test_log = "bun test\n(pass) a\n 146 pass\n 0 fail\nRan 146 tests across 17 files.\n"
    assert looks_bad("Did tests pass? Return PASS or FAIL.", test_log, INSUFFICIENT) == "false insufficient"
    assert looks_bad("Did tests pass? Return PASS or FAIL.", test_log, "PASS") is None

    npm_unmet = (
        "condense-workspace@1.5.2\n"
        "├── UNMET DEPENDENCY @clack/prompts@0.11.0\n"
        "└── UNMET DEPENDENCY condense@file:packages/cli\n"
        "npm error code ELSPROBLEMS\n"
        "npm error missing: @clack/prompts@0.11.0\n"
        "exit 1\n"
    )
    assert (
        looks_bad("Which packages are installed? Return only package names.", npm_unmet, INSUFFICIENT) is None
    )

    gh_404 = "failed to get runs: HTTP 404: Not Found (https://api.github.com/repos/x/y/actions/runs)\nexit 1\n"
    assert looks_bad("List the latest workflow runs. Return status and name only.", gh_404, INSUFFICIENT) is None
    assert looks_bad("Did CI pass? Return PASS or FAIL with failed jobs.", gh_404, INSUFFICIENT) is None

    pr_err = "GraphQL: Could not resolve to a Repository with the name 'x/y'. (repository)\nexit 1\n"
    assert looks_bad("List open pull requests. Return number and title only.", pr_err, INSUFFICIENT) is None

    tf_init = (
        "Initializing the backend...\n"
        "Initializing provider plugins...\n"
        "- Installing hashicorp/null v3.3.1...\n"
        "Terraform has been successfully initialized!\n"
        "You may now begin working with Terraform. Try running \"terraform plan\".\n"
        "exit 0\n"
    )
    assert (
        looks_bad("List resources that would be created or destroyed. One per line.", tf_init, INSUFFICIENT) is None
    )

    stat = (
        "src/config.ts             | 18 ++++++------------\n"
        " src/llm.ts                |  6 +++++-\n"
        " src/local-server.ts       |  6 +++---\n"
        " src/onboarding.ts         |  2 +-\n"
        " src/prompt.ts             | 42 ++++++++++++++++++++++++------------------\n"
        " test/config.test.ts       |  5 +----\n"
        " test/llm.test.ts          | 41 ++++++++++++++++++++++++++++++++++++++---\n"
        " test/local-server.test.ts | 11 ++++++-----\n"
        " 8 files changed, 84 insertions(+), 47 deletions(-)\n"
        "\n"
        "exit 0\n"
    )
    stat_q = "What changed? Return only the files changed and a one-line summary for each file."
    stat_ans = "\n".join(
        [
            "src/config.ts: 18 lines changed, net deletions",
            "src/llm.ts: 6 lines changed, mostly additions",
            "src/local-server.ts: 6 lines changed",
            "src/onboarding.ts: 2 lines changed",
            "src/prompt.ts: 42 lines changed, mixed",
            "test/config.test.ts: 5 lines changed",
            "test/llm.test.ts: 41 lines changed, mostly additions",
            "test/local-server.test.ts: 11 lines changed",
            "8 files changed, 84 insertions(+), 47 deletions(-)",
            "extra detail to exceed raw length plus slack " * 8,
        ]
    )
    assert len(stat_ans) > len(stat) + 80
    assert looks_bad(stat_q, stat, stat_ans) is None

    essay = ("The command completed successfully. " * 30).strip()
    assert looks_bad("Summarize the output in one sentence.", "hello world from cmd\nexit 0\n", essay) == "longer than source"

    audit = "lodash <=4.17.23\nSeverity: critical\nPrototype Pollution\nexit 1\n"
    assert (
        looks_bad(
            "List high or critical findings. One per line. If none, return PASS.",
            audit,
            "lodash <=4.17.23 — critical",
        )
        is None
    )
    docker_run = "boom\nls: /nope: No such file or directory\nexit 2\n"
    assert (
        looks_bad(
            "Any containers not in running status? Return PASS or FAIL with names.",
            docker_run,
            INSUFFICIENT,
        )
        is None
    )
    ci_pending = "pendingprocess.env delete\nin_progressprocess.env lint\nexit 0\n"
    assert looks_bad("Did CI pass? Return PASS or FAIL with failed jobs.", ci_pending, INSUFFICIENT) is None
    ci_ok = '[\n  {"conclusion": "success", "name": "test"}\n]\nexit 0\n'
    assert looks_bad("Did CI pass? Return PASS or FAIL with failed jobs.", ci_ok, INSUFFICIENT) == "false insufficient"

    ts_q = "Did any TypeScript source files change? Return only those paths."
    docs_stat = "04955d6 docs: align model source label\n README.md | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\nexit 0\n"
    ts_stat = "src/prompt.ts | 4 ++++\n 1 file changed, 4 insertions(+)\nexit 0\n"
    assert is_zero_match_path_list(ts_q, docs_stat)
    assert not is_zero_match_path_list(ts_q, ts_stat)
    assert normalize_completion(ts_q, docs_stat, "") == NONE
    assert normalize_completion(ts_q, docs_stat, None) == NONE
    assert normalize_completion(ts_q, ts_stat, "") == ""
    assert looks_bad(ts_q, docs_stat, NONE) is None
    assert looks_bad(ts_q, ts_stat, NONE) == "false NONE"

    rows = []
    for log, questions in (
        ("LOG-A\n" + "x" * 40, ["q1", "q2", "q3"]),
        ("LOG-B\n" + "y" * 40, ["q1", "q2"]),
        ("LOG-C\n" + "z" * 40, ["q1"]),
        ("LOG-D\n" + "w" * 40, ["q1", "q2"]),
        ("LOG-E\n" + "v" * 40, ["q1"]),
    ):
        for question in questions:
            rows.append(
                {
                    "messages": [
                        {"role": "system", "content": "s"},
                        {"role": "user", "content": user_content(question, log)},
                        {"role": "assistant", "content": "ok"},
                    ],
                    "metadata": {"id": pair_id(question, log), "source_hash": source_hash(log)},
                }
            )
    train, valid = split_by_source(rows, valid_frac=0.3, seed=0)
    train_h = {labeled_source_hash(row) for row in train}
    valid_h = {labeled_source_hash(row) for row in valid}
    assert train and valid
    assert not (train_h & valid_h)

    rejected_rows = [
        {"id": "deadbeefdeadbeef", "reason": "empty", "task": "generic"},
        {"id": rows[0]["metadata"]["id"], "reason": "request: empty completion", "task": "generic"},
    ]
    pair_rows = [
        {
            "id": rows[0]["metadata"]["id"],
            "question": "q1",
            "input": "LOG-A\n" + "x" * 40,
            "task": "generic",
            "source": "harvest",
        }
    ]
    rec = materialize_retry_row(rejected_rows[1], {pair_rows[0]["id"]: pair_rows[0]})
    assert rec is not None
    assert rec["question"] == "q1"
    assert rec["retry_reason"] == "request: empty completion"
    assert materialize_retry_row(rejected_rows[0], {pair_rows[0]["id"]: pair_rows[0]}) is None
    print("self-test ok")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    extract = sub.add_parser("extract")
    extract.add_argument("--raw", type=Path, nargs="*", default=[])
    extract.add_argument("--raw-dir", type=Path, default=None)
    extract.add_argument("--out", type=Path, required=True)

    capture = sub.add_parser("capture")
    capture.add_argument("--question", required=True)
    capture.add_argument("--task", default="generic")
    capture.add_argument("--out", type=Path, required=True)

    label = sub.add_parser("label")
    label.add_argument("--pairs", type=Path, required=True)
    label.add_argument("--system-file", type=Path, required=True)
    label.add_argument("--out-dir", type=Path, required=True)
    label.add_argument("--host", default=None)
    label.add_argument("--model", default=None)
    label.add_argument("--timeout", type=float, default=120)
    label.add_argument("--seed", type=int, default=0)
    label.add_argument("--dry-run", action="store_true")
    label.add_argument("--fresh", action="store_true")
    label.add_argument("--retry-only", action="store_true")
    label.add_argument("--stop-at", type=int, default=None)

    retry_sync = sub.add_parser("retry-sync")
    retry_sync.add_argument("--pairs", type=Path, required=True)
    retry_sync.add_argument("--out-dir", type=Path, required=True)

    sub.add_parser("self-test")
    args = parser.parse_args()
    if args.cmd == "extract":
        return cmd_extract(args)
    if args.cmd == "capture":
        return cmd_capture(args)
    if args.cmd == "label":
        return cmd_label(args)
    if args.cmd == "retry-sync":
        return cmd_retry_sync(args)
    return cmd_self_test()


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Capture a registered real command without invoking Condense or labelling it."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def timestamp():
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def instant(value):
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Timestamps must include a timezone")
    return parsed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    freeze_path = root / "train/bench/production_validation_freeze.json"
    protocol_path = root / "train/bench/PRODUCTION_VALIDATION.md"
    freeze = json.loads(freeze_path.read_text())
    roster_bytes = args.sources.read_bytes()
    roster = json.loads(roster_bytes)
    started_at = timestamp()
    if roster.get("evaluation_id") != freeze["evaluation_id"]:
        raise ValueError("Source roster belongs to a different evaluation")
    if not roster.get("registered_at") or not (
        instant(freeze["frozen_at"]) <= instant(roster["registered_at"]) < instant(started_at)
    ):
        raise ValueError("Register sources after the freeze and before collection")
    window = roster.get("collection_window", {})
    if not window.get("start") or not window.get("end") or not roster.get("selection_rule"):
        raise ValueError("Preregister a collection window and selection rule")
    if not (instant(roster["registered_at"]) <= instant(window["start"]) <= instant(started_at) < instant(window["end"])):
        raise ValueError("Collection must be inside the preregistered time window")
    sources = roster.get("sources", [])
    identifiers = [s["id"] for s in sources]
    if len(set(identifiers)) != len(identifiers):
        raise ValueError("Source IDs must be unique")
    matches = [s for s in sources if s["id"] == args.source]
    if len(matches) != 1:
        raise ValueError("Command must belong to the preregistered source roster")
    source = matches[0]
    project = Path(source["project"]).expanduser().resolve(strict=True)
    command = source["argv"]
    if not project.is_dir() or not isinstance(source.get("question"), str) or not source["question"] or not isinstance(command, list) or not command or not all(isinstance(a, str) for a in command):
        raise ValueError("Source needs a project directory, question and argv")
    if Path(command[0]).name in ("condense", "rtk"):
        raise ValueError("Capture the native producer; filtered output is not raw evidence")
    reports = source.get("reports", [])
    report_paths = [(project / name).resolve() for name in reports]
    if any(not path.is_relative_to(project) for path in report_paths):
        raise ValueError("Report paths must stay inside the source project")
    output = args.output.expanduser().resolve()
    if any(output.is_relative_to(path) for path in (root, project, Path.home() / ".config/condense")):
        raise ValueError("Keep blind data outside repositories and production Condense data")
    output.mkdir(parents=True, exist_ok=True)
    registration = {
        "evaluation_id": freeze["evaluation_id"], "sources_sha256": hashlib.sha256(roster_bytes).hexdigest(),
        "freeze_sha256": digest(freeze_path), "protocol_sha256": digest(protocol_path),
        "collector_sha256": digest(Path(__file__)),
        "sources": roster
    }
    registration_path = output / "registration.json"
    if registration_path.exists():
        if json.loads(registration_path.read_text()) != registration:
            raise ValueError("Source roster, freeze or protocol changed after collection began")
    else:
        with registration_path.open("x") as stream:
            json.dump(registration, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
    sample_id = uuid.uuid4().hex
    sample = output / sample_id
    sample.mkdir()
    raw_path = sample / "raw.log"
    env = dict(os.environ)
    env.update(source.get("environment", {}))
    started_at = timestamp()
    if instant(started_at) >= instant(window["end"]):
        raise ValueError("Collection window ended before command startup")
    start_ns = time.time_ns()
    start = time.monotonic()
    # stdout and stderr share one native byte stream, equivalent to 2>&1.
    with raw_path.open("xb") as raw:
        result = subprocess.run(command, cwd=project, env=env, stdout=raw, stderr=subprocess.STDOUT)
    completed_at = timestamp()
    producer_duration_ms = round((time.monotonic() - start) * 1000, 2)
    attachments = []
    for index, (name, path) in enumerate(zip(reports, report_paths)):
        if not path.is_file():
            attachments.append({"source_path": name, "status": "missing"})
            continue
        data = path.read_bytes()
        copied = sample / f"report-{index}{path.suffix}"
        copied.write_bytes(data)
        attachments.append({"source_path": name, "snapshot_path": copied.name,
                            "sha256": digest(copied), "modified_during_run": path.stat().st_mtime_ns >= start_ns})
    record = {
        "sample_id": sample_id, "evaluation_id": freeze["evaluation_id"], "source_id": args.source,
        "collection_started_at": started_at, "collection_completed_at": completed_at,
        "project": str(project), "actual_command": command, "question": source["question"],
        "declared_environment": source.get("environment", {}),
        "environment_sha256": hashlib.sha256(json.dumps(env, sort_keys=True).encode()).hexdigest(),
        "producer_exit_code": result.returncode, "producer_duration_ms": producer_duration_ms,
        "raw_file": raw_path.name, "raw_sha256": digest(raw_path), "raw_bytes": raw_path.stat().st_size,
        "reports": attachments, "sources_sha256": registration["sources_sha256"],
        "label_status": "pending_independent_review", "duplicate_status": "pending",
        "independence_status": "pending_audit", "eligible_for_blind_evaluation": False
    }
    record_path = sample / "provenance.json"
    record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
    print(record_path)
    return result.returncode if result.returncode >= 0 else 128 - result.returncode


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, KeyError, OSError) as error:
        print(f"collection failed: {error}", file=sys.stderr)
        sys.exit(2)

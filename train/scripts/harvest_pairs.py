#!/usr/bin/env python3
"""Run real commands and append (question, input) pairs for teacher labeling."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from label_teacher import load_jsonl, pair_id, source_hash, usable_pair, write_jsonl

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "train" / "data" / "pairs.jsonl"
MAX_INPUT = 8000

TASK_CAPS = {
    "test_result": 120,
    "pass_fail": 100,
    "terraform_plan": 100,
    "security_audit": 80,
    "typescript_check": 80,
    "docker_k8s": 80,
    "generic": 500,
}

Q_TEST = [
    "Did tests pass? Return PASS or FAIL, followed by failing test names if any.",
    "PASS or FAIL? List failed names and the first raw error line for each.",
    "How many tests passed and failed? Return only the counts.",
]
Q_GIT_STATUS = [
    "What changed? Return only modified files and a one-line summary.",
    "List untracked files only, one per line.",
    "Is the working tree clean? Return PASS or FAIL with dirty paths.",
]
Q_GIT_LOG = [
    "List the recent commits. Return only hash and subject, one per line.",
    "What is the latest commit? Return hash and subject only.",
]
Q_GIT_DIFF = [
    "What changed? Return only the files changed and a one-line summary for each file.",
    "Did any TypeScript source files change? Return only those paths.",
]
Q_AUDIT = [
    "Extract the vulnerabilities. Return valid JSON only.",
    "List high or critical findings. One per line. If none, return PASS.",
]
Q_DOCKER = [
    "List running containers. Return name and status only.",
    "Any containers not in running status? Return PASS or FAIL with names.",
]
Q_K8S = [
    "Any pods not in Running status? Return PASS or FAIL with bad pods.",
    "List resources that are not Ready or Running. One per line.",
]
Q_TF = [
    "Is this safe? Return SAFE, REVIEW, or UNSAFE, followed by the exact risky changes.",
    "Did terraform succeed? Return PASS or FAIL with the first error line.",
    "List resources that would be created or destroyed. One per line.",
]
Q_CI = [
    "Did CI pass? Return PASS or FAIL with failed jobs.",
    "List the latest workflow runs. Return status and name only.",
]
Q_BUILD = [
    "Did the build succeed? Return PASS or FAIL, listing exact error files and line numbers.",
    "List compiler errors only. One file:line per line.",
]
Q_BUILD_GAP = Q_BUILD + ["How many compiler errors are there? Return only the count."]
Q_AUDIT_GAP = Q_AUDIT + [
    "Did the audit find vulnerabilities? Return PASS or FAIL with high/critical counts."
]
Q_DOCKER_GAP = Q_DOCKER + [
    "Did the container succeed? Return PASS or FAIL with the first error line.",
    "List error lines only. One per line.",
]
Q_K8S_GAP = Q_K8S + ["Did kubectl succeed? Return PASS or FAIL with the first error line."]
GAP_CAPS = {
    "typescript_check": 180,
    "security_audit": 160,
    "docker_k8s": 160,
    "terraform_plan": 180,
}
CI_REPOS = [
    "cli/cli",
    "actions/checkout",
    "oven-sh/bun",
    "hashicorp/terraform",
    "kubernetes/kubernetes",
]
CI_REPOS_EXTRA = [
    "cli/cli",
    "docker/cli",
    "hashicorp/vault",
    "microsoft/TypeScript",
    "nodejs/node",
    "rust-lang/cargo",
    "golang/go",
]


def fit_input(text: str, max_chars: int = MAX_INPUT) -> str:
    if len(text) <= max_chars:
        return text
    half = max_chars // 2 - 50
    dropped = len(text) - half * 2
    return f"{text[:half]}\n... [{dropped} chars truncated] ...\n{text[-half:]}"


def run_cmd(argv: list[str], cwd: Path, timeout: float = 90) -> str:
    try:
        proc = subprocess.run(
            argv,
            cwd=str(cwd),
            capture_output=True,
            timeout=timeout,
            text=True,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return f"command failed: {argv[0]}: {exc}\n"
    out = (proc.stdout or "") + (proc.stderr or "")
    if not out.strip():
        out = f"exit {proc.returncode} (no output)\n"
    else:
        out = out + f"\nexit {proc.returncode}\n"
    return fit_input(out)


def task_count(rows: list[dict], task: str) -> int:
    return sum(1 for row in rows if row.get("task") == task)


def room(rows: list[dict], task: str, start_n: int, limit: int) -> bool:
    if len(rows) - start_n >= limit:
        return False
    cap = TASK_CAPS.get(task)
    return cap is None or task_count(rows, task) < cap


def append_pairs(
    rows: list[dict],
    question: str,
    raw_input: str,
    task: str,
    source: str,
    start_n: int,
    limit: int,
) -> bool:
    if not room(rows, task, start_n, limit):
        return False
    pair = {
        "question": question.strip(),
        "input": raw_input.strip(),
        "task": task,
        "source": source,
        "id": pair_id(question.strip(), raw_input.strip()),
        "source_hash": source_hash(raw_input.strip()),
    }
    if usable_pair(pair):
        return False
    if any(existing.get("id") == pair["id"] for existing in rows):
        return False
    rows.append(pair)
    return True


def add_log(
    rows: list[dict],
    raw_input: str,
    task: str,
    questions: list[str],
    source: str,
    start_n: int,
    limit: int,
) -> int:
    added = 0
    for question in questions:
        if append_pairs(rows, question, raw_input, task, source, start_n, limit):
            added += 1
    return added


def harvest_fail_tests(rows: list[dict], start_n: int, limit: int) -> None:
    cases = [
        (
            "auth.test.ts",
            """import { test, expect } from "bun:test";
test("auth rejects missing token", () => {
  expect("unauthorized").toBe("ok");
});
test("auth accepts a bearer token", () => {
  expect(true).toBe(true);
});
""",
        ),
        (
            "invoice.test.ts",
            """import { test, expect } from "bun:test";
test("sums invoices", () => {
  expect(1 + 1).toBe(3);
});
test("rejects negative totals", () => {
  throw new Error("expected total >= 0, got -4");
});
""",
        ),
        (
            "queue.test.ts",
            """import { test, expect } from "bun:test";
test("drains the queue", () => {
  expect(["job-a", "job-b"]).toEqual(["job-a"]);
});
test("times out stale jobs", () => {
  expect("running").toBe("timed-out");
});
test("acks a completed job", () => {
  expect(1).toBe(1);
});
""",
        ),
    ]
    d = Path(tempfile.mkdtemp(prefix="condense-fail-"))
    try:
        for name, body in cases:
            if not room(rows, "test_result", start_n, limit):
                return
            (d / name).write_text(body)
            output = run_cmd(["bun", "test", str(d / name)], d, 60)
            add_log(rows, output, "test_result", Q_TEST, "harvest-fail", start_n, limit)
        all_out = run_cmd(["bun", "test", str(d)], d, 60)
        add_log(rows, all_out, "test_result", Q_TEST, "harvest-fail", start_n, limit)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def harvest_typescript(rows: list[dict], start_n: int, limit: int) -> None:
    files = {
        "math.ts": """export function add(a: number, b: number): number { return a + b; }
add("1", 2);
const n: number = "three";
export const user: { id: number } = { id: "u1" };
missingFn(n);
""",
        "api.ts": """type User = { id: string; name: string };
function load(id: number): User { return { id, name: 1 }; }
const x: User = load("abc");
x.missing.ok;
""",
        "db.ts": """interface Row { id: number; email: string }
const rows: Row[] = [{ id: "1" }];
function save(row: Row): void { row.email.toUpperCase(); }
save({ id: 1 });
const ok: string = save({ id: 2, email: "a@b.c" });
""",
    }
    d = Path(tempfile.mkdtemp(prefix="condense-ts-"))
    try:
        (d / "tsconfig.json").write_text(
            json.dumps(
                {
                    "compilerOptions": {
                        "strict": True,
                        "noEmit": True,
                        "target": "ES2020",
                        "module": "ESNext",
                    },
                    "include": ["*.ts"],
                }
            )
        )
        for name, body in files.items():
            (d / name).write_text(body)
        output = run_cmd(
            ["npx", "-y", "--package", "typescript", "tsc", "--noEmit", "-p", str(d)],
            d,
            90,
        )
        add_log(rows, output, "typescript_check", Q_BUILD, "harvest-ts", start_n, limit)
        for name in files:
            one = run_cmd(
                ["npx", "-y", "--package", "typescript", "tsc", "--noEmit", "--strict", str(d / name)],
                d,
                90,
            )
            add_log(rows, one, "typescript_check", Q_BUILD, "harvest-ts", start_n, limit)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def harvest_npm_audit(rows: list[dict], start_n: int, limit: int) -> None:
    manifests = [
        {"name": "audit-fixture-a", "dependencies": {"lodash": "4.17.4", "minimist": "0.0.8"}},
        {"name": "audit-fixture-b", "dependencies": {"debug": "2.6.8", "qs": "6.5.1", "hoek": "4.2.0"}},
    ]
    for manifest in manifests:
        if not room(rows, "security_audit", start_n, limit):
            return
        d = Path(tempfile.mkdtemp(prefix="condense-audit-"))
        try:
            (d / "package.json").write_text(json.dumps(manifest))
            run_cmd(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"], d, 120)
            text = run_cmd(["npm", "audit"], d, 60)
            blob = run_cmd(["npm", "audit", "--json"], d, 60)
            add_log(rows, text, "security_audit", Q_AUDIT, "harvest-audit", start_n, limit)
            add_log(rows, blob, "security_audit", Q_AUDIT, "harvest-audit", start_n, limit)
        finally:
            shutil.rmtree(d, ignore_errors=True)


def harvest_terraform(rows: list[dict], start_n: int, limit: int) -> None:
    d = Path(tempfile.mkdtemp(prefix="condense-tf-"))
    try:
        (d / "main.tf").write_text(
            """
terraform {
  required_version = ">= 1.0"
  required_providers {
    local = { source = "hashicorp/local" }
    null  = { source = "hashicorp/null" }
  }
}

resource "local_file" "keep" {
  content  = "keep"
  filename = "${path.module}/keep.txt"
}

resource "local_file" "gone" {
  content  = "gone"
  filename = "${path.module}/gone.txt"
}

resource "null_resource" "old" {
  triggers = { force = "destroy-me" }
}
""".strip()
            + "\n"
        )
        init_out = run_cmd(["terraform", "init", "-input=false", "-no-color"], d, 90)
        plan_out = run_cmd(["terraform", "plan", "-input=false", "-no-color"], d, 90)
        apply_out = run_cmd(
            ["terraform", "apply", "-input=false", "-auto-approve", "-no-color"], d, 90
        )
        (d / "main.tf").write_text(
            """
terraform {
  required_version = ">= 1.0"
  required_providers {
    local = { source = "hashicorp/local" }
    null  = { source = "hashicorp/null" }
  }
}

resource "local_file" "keep" {
  content  = "keep-v2"
  filename = "${path.module}/keep.txt"
}
""".strip()
            + "\n"
        )
        change_out = run_cmd(["terraform", "plan", "-input=false", "-no-color"], d, 90)
        destroy_out = run_cmd(
            ["terraform", "plan", "-destroy", "-input=false", "-no-color"], d, 90
        )
        for output in (init_out, plan_out, apply_out, change_out, destroy_out):
            add_log(rows, output, "terraform_plan", Q_TF, "harvest-tf", start_n, limit)
        run_cmd(["terraform", "destroy", "-input=false", "-auto-approve", "-no-color"], d, 90)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def parse_json_output(blob: str):
    body = blob.rsplit("\nexit ", 1)[0]
    try:
        return json.loads(body or "[]")
    except json.JSONDecodeError:
        return None


def pretty_cmd_json(blob: str) -> str:
    payload = parse_json_output(blob)
    if payload is None:
        return blob
    footer = ""
    if "\nexit " in blob:
        footer = "\nexit " + blob.rsplit("\nexit ", 1)[1]
    return json.dumps(payload, indent=2) + footer


def harvest_github_actions(rows: list[dict], start_n: int, limit: int, repos: list[str] | None = None) -> None:
    json_fields = "databaseId,status,conclusion,name,displayTitle,headBranch,event"
    for repo in repos or CI_REPOS:
        if not room(rows, "pass_fail", start_n, limit):
            return
        blob = run_cmd(
            ["gh", "run", "list", "-R", repo, "--limit", "15", "--json", json_fields],
            ROOT,
            30,
        )
        add_log(rows, pretty_cmd_json(blob), "pass_fail", Q_CI, "harvest-ci", start_n, limit)
        fail_blob = run_cmd(
            [
                "gh",
                "run",
                "list",
                "-R",
                repo,
                "--status",
                "failure",
                "--limit",
                "6",
                "--json",
                json_fields,
            ],
            ROOT,
            30,
        )
        add_log(rows, pretty_cmd_json(fail_blob), "pass_fail", Q_CI, "harvest-ci", start_n, limit)
        runs = parse_json_output(blob) or []
        fails = parse_json_output(fail_blob) or []
        fail = next((run for run in fails + runs if run.get("conclusion") == "failure"), None)
        ok = next((run for run in runs if run.get("conclusion") == "success"), None)
        if fail:
            log = run_cmd(
                ["gh", "run", "view", str(fail["databaseId"]), "-R", repo, "--log-failed"],
                ROOT,
                60,
            )
            add_log(rows, log, "pass_fail", Q_CI, "harvest-ci", start_n, limit)
            view = run_cmd(
                ["gh", "run", "view", str(fail["databaseId"]), "-R", repo],
                ROOT,
                30,
            )
            add_log(rows, view, "pass_fail", Q_CI, "harvest-ci", start_n, limit)
        if ok:
            view = run_cmd(
                ["gh", "run", "view", str(ok["databaseId"]), "-R", repo],
                ROOT,
                30,
            )
            add_log(rows, view, "pass_fail", Q_CI, "harvest-ci", start_n, limit)


def harvest_docker_k8s(rows: list[dict], start_n: int, limit: int) -> None:
    add_log(
        rows,
        run_cmd(["docker", "ps", "--format", "{{.Names}} {{.Status}}"], ROOT, 30),
        "docker_k8s",
        Q_DOCKER,
        "harvest-docker",
        start_n,
        limit,
    )
    add_log(
        rows,
        run_cmd(["docker", "ps", "-a", "--format", "{{.Names}} {{.Status}}"], ROOT, 30),
        "docker_k8s",
        Q_DOCKER,
        "harvest-docker",
        start_n,
        limit,
    )
    names = ("condense-harvest-fail", "condense-harvest-exited")
    for name in names:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True, text=True)
    fail = run_cmd(
        [
            "docker",
            "run",
            "--name",
            "condense-harvest-fail",
            "alpine:3.20",
            "sh",
            "-c",
            "echo boom; ls /nope; exit 2",
        ],
        ROOT,
        90,
    )
    q_container = [
        "Did the container succeed? Return PASS or FAIL with the first error line.",
        "List error lines only. One per line.",
    ]
    add_log(rows, fail, "docker_k8s", q_container, "harvest-docker", start_n, limit)
    logs = run_cmd(["docker", "logs", "condense-harvest-fail"], ROOT, 20)
    add_log(rows, logs, "docker_k8s", Q_DOCKER, "harvest-docker", start_n, limit)
    inspect = run_cmd(["docker", "inspect", "condense-harvest-fail", "--format", "{{.State.Status}} {{.State.ExitCode}} {{.Name}}"], ROOT, 20)
    add_log(
        rows,
        inspect,
        "docker_k8s",
        ["Did the container succeed? Return PASS or FAIL with the first error line."],
        "harvest-docker",
        start_n,
        limit,
    )
    run_cmd(["docker", "run", "--name", "condense-harvest-exited", "alpine:3.20", "sh", "-c", "exit 137"], ROOT, 90)
    add_log(
        rows,
        run_cmd(["docker", "ps", "-a", "--format", "{{.Names}} {{.Status}} {{.Image}}"], ROOT, 20),
        "docker_k8s",
        Q_DOCKER,
        "harvest-docker",
        start_n,
        limit,
    )
    for name in names:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True, text=True)

    for argv in (
        ["kubectl", "get", "pods", "-A"],
        ["kubectl", "get", "nodes"],
        ["kubectl", "get", "events", "-A"],
        ["kubectl", "describe", "pod", "condense-missing"],
        ["kubectl", "logs", "condense-missing"],
    ):
        add_log(rows, run_cmd(argv, ROOT, 20), "docker_k8s", Q_K8S, "harvest-k8s", start_n, limit)


def harvest_more_fail_tests(rows: list[dict], start_n: int, limit: int) -> None:
    d = Path(tempfile.mkdtemp(prefix="condense-fail2-"))
    try:
        (d / "pay.test.ts").write_text(
            """import { test, expect } from "bun:test";
test("charges a card", () => { expect("declined").toBe("captured"); });
test("retries a 500", () => { throw new Error("upstream 502 from stripe"); });
test("stores the receipt", () => { expect(true).toBe(true); });
"""
        )
        add_log(rows, run_cmd(["bun", "test", str(d / "pay.test.ts")], d, 60), "test_result", Q_TEST, "harvest-fail", start_n, limit)

        py = d / "test_ledger.py"
        py.write_text(
            """import unittest
class LedgerTest(unittest.TestCase):
    def test_balance(self):
        self.assertEqual(2 + 2, 5)
    def test_transfer(self):
        raise RuntimeError("insufficient funds account=42")
    def test_ok(self):
        self.assertTrue(True)
if __name__ == "__main__":
    unittest.main()
"""
        )
        add_log(rows, run_cmd(["python3", str(py)], d, 30), "test_result", Q_TEST, "harvest-fail", start_n, limit)

        (d / "go.mod").write_text("module condense-fail\n\ngo 1.22\n")
        (d / "sum_test.go").write_text(
            """package main
import "testing"
func TestSum(t *testing.T) { t.Fatalf("got 3 want 4") }
func TestOK(t *testing.T) {}
func TestNil(t *testing.T) { t.Error("unexpected nil pointer in decoder") }
"""
        )
        add_log(rows, run_cmd(["go", "test", "-count=1"], d, 60), "test_result", Q_TEST, "harvest-fail", start_n, limit)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def harvest_docker_build(rows: list[dict], start_n: int, limit: int) -> None:
    d = Path(tempfile.mkdtemp(prefix="condense-dock-"))
    try:
        (d / "Dockerfile").write_text("FROM alpine:3.20\nRUN echo compiling && ls /nope/missing && false\n")
        build = run_cmd(["docker", "build", "-t", "condense-harvest-failimg", str(d)], d, 120)
        add_log(
            rows,
            build,
            "docker_k8s",
            [
                "Did the build succeed? Return PASS or FAIL, listing exact error files and line numbers.",
                "List error lines only. One per line.",
            ],
            "harvest-docker",
            start_n,
            limit,
        )
        subprocess.run(["docker", "rmi", "-f", "condense-harvest-failimg"], capture_output=True, text=True)
        (d / "compose.yaml").write_text(
            "services:\n  web:\n    image: alpine:3.20\n    command: [sh, -c, 'echo crash; exit 9']\n"
        )
        add_log(
            rows,
            run_cmd(["docker", "compose", "-f", str(d / "compose.yaml"), "config"], d, 30),
            "docker_k8s",
            Q_DOCKER,
            "harvest-docker",
            start_n,
            limit,
        )
    finally:
        shutil.rmtree(d, ignore_errors=True)


def harvest_k8s_manifests(rows: list[dict], start_n: int, limit: int) -> None:
    d = Path(tempfile.mkdtemp(prefix="condense-k8s-"))
    try:
        (d / "bad-pod.yaml").write_text(
            """apiVersion: v1
kind: Pod
metadata:
  name: api-aa
spec:
  containers:
    - name: api
      image: nginx
      resources:
        limits:
          memory: not-a-qty
      ports:
        - containerPort: "http"
"""
        )
        (d / "crash.yaml").write_text(
            """apiVersion: v1
kind: Pod
metadata:
  name: worker-xy
spec:
  containers:
    - name: worker
      image: ""
      command: ["boom"]
"""
        )
        for name in ("bad-pod.yaml", "crash.yaml"):
            out = run_cmd(
                ["kubectl", "apply", "--dry-run=client", "-f", str(d / name)],
                d,
                20,
            )
            add_log(rows, out, "docker_k8s", Q_K8S, "harvest-k8s", start_n, limit)
        add_log(
            rows,
            run_cmd(["kubectl", "apply", "--dry-run=client", "-f", str(d / "missing.yaml")], d, 20),
            "docker_k8s",
            Q_K8S,
            "harvest-k8s",
            start_n,
            limit,
        )
    finally:
        shutil.rmtree(d, ignore_errors=True)


def harvest_terraform_replace(rows: list[dict], start_n: int, limit: int) -> None:
    d = Path(tempfile.mkdtemp(prefix="condense-tf2-"))
    try:
        (d / "main.tf").write_text(
            """
terraform {
  required_providers {
    local = { source = "hashicorp/local" }
    null  = { source = "hashicorp/null" }
  }
}

resource "null_resource" "web" {
  triggers = { ami = "ami-111" }
}

resource "local_file" "db" {
  content  = "prod-db"
  filename = "${path.module}/db.txt"
}

resource "local_file" "old_bucket" {
  content  = "force-destroy"
  filename = "${path.module}/bucket.txt"
}
""".strip()
            + "\n"
        )
        run_cmd(["terraform", "init", "-input=false", "-no-color"], d, 90)
        run_cmd(["terraform", "apply", "-input=false", "-auto-approve", "-no-color"], d, 90)
        (d / "main.tf").write_text(
            """
terraform {
  required_providers {
    local = { source = "hashicorp/local" }
    null  = { source = "hashicorp/null" }
  }
}

resource "null_resource" "web" {
  triggers = { ami = "ami-222" }
}

resource "local_file" "db" {
  content  = "prod-db-v2"
  filename = "${path.module}/db.txt"
}
""".strip()
            + "\n"
        )
        change = run_cmd(["terraform", "plan", "-input=false", "-no-color"], d, 90)
        destroy = run_cmd(["terraform", "plan", "-destroy", "-input=false", "-no-color"], d, 90)
        add_log(rows, change, "terraform_plan", Q_TF, "harvest-tf", start_n, limit)
        add_log(rows, destroy, "terraform_plan", Q_TF, "harvest-tf", start_n, limit)
        run_cmd(["terraform", "destroy", "-input=false", "-auto-approve", "-no-color"], d, 90)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def harvest_more_typescript(rows: list[dict], start_n: int, limit: int) -> None:
    d = Path(tempfile.mkdtemp(prefix="condense-ts2-"))
    try:
        (d / "app.ts").write_text(
            """type Event = { type: "click"; x: number };
function handle(e: Event) { return e.y.toFixed(1); }
const e: Event = { type: "click" };
handle({ type: "press", x: "0" });
const xs: number[] = ["1", 2, null];
"""
        )
        (d / "store.ts").write_text(
            """interface Item { id: number; sku: string }
function put(item: Item): Promise<Item> { return item; }
put({ sku: "abc" });
const a: Item = JSON.parse("{}");
a.id.map(Boolean);
"""
        )
        out = run_cmd(
            ["npx", "-y", "--package", "typescript", "tsc", "--noEmit", "--strict", str(d / "app.ts"), str(d / "store.ts")],
            d,
            90,
        )
        add_log(rows, out, "typescript_check", Q_BUILD, "harvest-ts", start_n, limit)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def harvest_sparse(rows: list[dict], start_n: int, limit: int) -> None:
    manifests = [
        {"name": "audit-fixture-c", "dependencies": {"express": "4.16.0", "moment": "2.19.3", "axios": "0.18.0"}},
        {"name": "audit-fixture-d", "dependencies": {"ws": "5.2.0", "tar": "2.2.1", "node-fetch": "1.7.3"}},
        {"name": "audit-fixture-e", "dependencies": {"underscore": "1.8.3", "handlebars": "4.0.5", "jquery": "3.0.0"}},
    ]
    for manifest in manifests:
        d = Path(tempfile.mkdtemp(prefix="condense-audit2-"))
        try:
            (d / "package.json").write_text(json.dumps(manifest))
            run_cmd(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"], d, 120)
            add_log(rows, run_cmd(["npm", "audit"], d, 60), "security_audit", Q_AUDIT, "harvest-audit", start_n, limit)
            add_log(rows, run_cmd(["npm", "audit", "--json"], d, 60), "security_audit", Q_AUDIT, "harvest-audit", start_n, limit)
        finally:
            shutil.rmtree(d, ignore_errors=True)

    d = Path(tempfile.mkdtemp(prefix="condense-ts3-"))
    try:
        files = {
            "router.ts": """type Params = { id: number };
function get(p: Params): string { return p.slug.toUpperCase(); }
get({ id: "12" });
const n: number = get({ id: 1 });
JSON.parse(1).map(Boolean);
""",
            "cache.ts": """class Cache<T> { get(k: string): T { return k; } }
const c = new Cache<number>();
c.get(1).trim();
const xs: string[] = [c.get("a"), null];
""",
            "http.ts": """export async function load(url: URL): Promise<{ ok: true }> {
  return fetch(url).then(r => r.json());
}
load("/users");
const body: string = await load(new URL("http://x"));
""",
        }
        for name, body in files.items():
            (d / name).write_text(body)
        add_log(
            rows,
            run_cmd(
                ["npx", "-y", "--package", "typescript", "tsc", "--noEmit", "--strict", *map(str, d.glob("*.ts"))],
                d,
                90,
            ),
            "typescript_check",
            Q_BUILD,
            "harvest-ts",
            start_n,
            limit,
        )
        for name in files:
            add_log(
                rows,
                run_cmd(
                    ["npx", "-y", "--package", "typescript", "tsc", "--noEmit", "--strict", str(d / name)],
                    d,
                    90,
                ),
                "typescript_check",
                Q_BUILD,
                "harvest-ts",
                start_n,
                limit,
            )
    finally:
        shutil.rmtree(d, ignore_errors=True)

    inspect = run_cmd(["docker", "inspect", "cli-proxy-api"], ROOT, 20)
    add_log(
        rows,
        inspect,
        "docker_k8s",
        [
            "List running containers. Return name and status only.",
            "Did the container succeed? Return PASS or FAIL with the first error line.",
        ],
        "harvest-docker",
        start_n,
        limit,
    )
    add_log(
        rows,
        run_cmd(["docker", "logs", "--tail", "80", "cli-proxy-api"], ROOT, 20),
        "docker_k8s",
        ["List error lines only. One per line.", "Did the container succeed? Return PASS or FAIL with the first error line."],
        "harvest-docker",
        start_n,
        limit,
    )

    add_log(rows, run_cmd(["git", "diff", "--stat", "HEAD"], ROOT, 20), "generic", Q_GIT_DIFF, "harvest", start_n, limit)
    add_log(rows, run_cmd(["git", "log", "-12", "--format=%h %s"], ROOT, 20), "generic", Q_GIT_LOG, "harvest", start_n, limit)
    add_log(
        rows,
        run_cmd(["ls", "-l", "src"], ROOT, 20),
        "generic",
        ["Which files are shown? Return only the filenames, one per line.", "List TypeScript files only, one per line."],
        "harvest",
        start_n,
        limit,
    )
    add_log(
        rows,
        run_cmd(["git", "stash", "list"], ROOT, 20),
        "generic",
        ["List stash entries. Return only the stash ref and subject, one per line."],
        "harvest",
        start_n,
        limit,
    )

    d = Path(tempfile.mkdtemp(prefix="condense-tf3-"))
    try:
        (d / "main.tf").write_text(
            """
terraform {
  required_providers { local = { source = "hashicorp/local" } }
}
resource "local_file" "app" {
  count    = 3
  content  = "app-${count.index}"
  filename = "${path.module}/app-${count.index}.txt"
}
resource "local_file" "secret" {
  content  = "rotate-me"
  filename = "${path.module}/secret.txt"
}
""".strip()
            + "\n"
        )
        run_cmd(["terraform", "init", "-input=false", "-no-color"], d, 90)
        plan = run_cmd(["terraform", "plan", "-input=false", "-no-color"], d, 90)
        add_log(rows, plan, "terraform_plan", Q_TF, "harvest-tf", start_n, limit)
        run_cmd(["terraform", "apply", "-input=false", "-auto-approve", "-no-color"], d, 90)
        destroy = run_cmd(["terraform", "plan", "-destroy", "-input=false", "-no-color"], d, 90)
        add_log(rows, destroy, "terraform_plan", Q_TF, "harvest-tf", start_n, limit)
        run_cmd(["terraform", "destroy", "-input=false", "-auto-approve", "-no-color"], d, 90)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def harvest_volume(rows: list[dict], start_n: int, limit: int) -> None:
    blob = run_cmd(["git", "log", "-40", "--format=%H %s"], ROOT, 20)
    add_log(rows, blob, "generic", Q_GIT_LOG, "harvest", start_n, limit)
    hashes = []
    for line in blob.splitlines():
        sha = line.split(" ", 1)[0].strip()
        if len(sha) == 40 and all(ch in "0123456789abcdef" for ch in sha):
            hashes.append(sha)
    for sha in hashes[:28]:
        if not room(rows, "generic", start_n, limit):
            break
        add_log(
            rows,
            run_cmd(["git", "show", "--stat", "--oneline", "-1", sha], ROOT, 20),
            "generic",
            Q_GIT_LOG + Q_GIT_DIFF,
            "harvest",
            start_n,
            limit,
        )
    for sha in hashes[:12]:
        add_log(
            rows,
            run_cmd(["git", "show", "--format=fuller", "--stat", "-1", sha], ROOT, 20),
            "generic",
            Q_GIT_LOG + Q_GIT_DIFF,
            "harvest",
            start_n,
            limit,
        )
    for path in list(sorted((ROOT / "src").glob("*.ts"))) + list(sorted((ROOT / "test").glob("*.test.ts")))[:8]:
        rel = str(path.relative_to(ROOT))
        add_log(
            rows,
            run_cmd(["git", "log", "-6", "--stat", "--", rel], ROOT, 20),
            "generic",
            Q_GIT_LOG + Q_GIT_DIFF,
            "harvest",
            start_n,
            limit,
        )
        add_log(
            rows,
            run_cmd(["git", "blame", "-L", "1,40", "--", rel], ROOT, 20),
            "generic",
            ["Who last changed these lines? Return hash and author only, one per line."],
            "harvest",
            start_n,
            limit,
        )

    d = Path(tempfile.mkdtemp(prefix="condense-vol-"))
    try:
        (d / "pay.test.ts").write_text(
            """import { test, expect } from "bun:test";
test("refunds a capture", () => { expect("pending").toBe("refunded"); });
test("lists disputes", () => { expect(["d1"]).toEqual([]); });
"""
        )
        add_log(rows, run_cmd(["bun", "test", str(d / "pay.test.ts")], d, 60), "test_result", Q_TEST, "harvest-fail", start_n, limit)
        (d / "web.ts").write_text(
            """type Req = { path: string; method: "GET" | "POST" };
function route(r: Req): number { return r.path.startsWith("/") ? r.body : 0; }
const x: Req = { path: 1, method: "PUT" };
route({ path: "/", method: "GET" }).toUpperCase();
"""
        )
        add_log(
            rows,
            run_cmd(["npx", "-y", "--package", "typescript", "tsc", "--noEmit", "--strict", str(d / "web.ts")], d, 90),
            "typescript_check",
            Q_BUILD,
            "harvest-ts",
            start_n,
            limit,
        )
        (d / "package.json").write_text(json.dumps({"name": "audit-fixture-f", "dependencies": {"serialize-javascript": "1.4.0", "mixin-deep": "1.3.0"}}))
        run_cmd(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"], d, 120)
        add_log(rows, run_cmd(["npm", "audit"], d, 60), "security_audit", Q_AUDIT, "harvest-audit", start_n, limit)
        add_log(rows, run_cmd(["npm", "audit", "--json"], d, 60), "security_audit", Q_AUDIT, "harvest-audit", start_n, limit)
        (d / "main.tf").write_text(
            """
terraform {
  required_providers { local = { source = "hashicorp/local" } }
}
resource "local_file" "web" { content = "web" filename = "${path.module}/web.txt" }
resource "local_file" "cache" { content = "cache" filename = "${path.module}/cache.txt" }
""".strip()
            + "\n"
        )
        run_cmd(["terraform", "init", "-input=false", "-no-color"], d, 90)
        add_log(rows, run_cmd(["terraform", "plan", "-input=false", "-no-color"], d, 90), "terraform_plan", Q_TF, "harvest-tf", start_n, limit)
        run_cmd(["terraform", "apply", "-input=false", "-auto-approve", "-no-color"], d, 90)
        add_log(rows, run_cmd(["terraform", "plan", "-destroy", "-input=false", "-no-color"], d, 90), "terraform_plan", Q_TF, "harvest-tf", start_n, limit)
        run_cmd(["terraform", "destroy", "-input=false", "-auto-approve", "-no-color"], d, 90)
    finally:
        shutil.rmtree(d, ignore_errors=True)

    add_log(rows, run_cmd(["docker", "info"], ROOT, 20), "docker_k8s", Q_DOCKER, "harvest-docker", start_n, limit)
    add_log(
        rows,
        run_cmd(["docker", "inspect", "--format", "{{.Name}} {{.State.Status}} {{.State.Health.Status}}", "cli-proxy-api"], ROOT, 20),
        "docker_k8s",
        Q_DOCKER,
        "harvest-docker",
        start_n,
        limit,
    )


def harvest_more(rows: list[dict], start_n: int, limit: int) -> None:
    add_log(rows, run_cmd(["git", "log", "--all", "-30", "--oneline"], ROOT, 20), "generic", Q_GIT_LOG, "harvest", start_n, limit)
    add_log(rows, run_cmd(["git", "reflog", "-20"], ROOT, 20), "generic", Q_GIT_LOG, "harvest", start_n, limit)
    add_log(
        rows,
        run_cmd(["git", "shortlog", "-sn", "-20"], ROOT, 20),
        "generic",
        ["List authors and commit counts. Return count and name, one per line."],
        "harvest",
        start_n,
        limit,
    )
    for path in sorted((ROOT / "src").glob("*.ts"))[:8]:
        rel = str(path.relative_to(ROOT))
        add_log(
            rows,
            run_cmd(["git", "log", "-2", "-p", "--", rel], ROOT, 30),
            "generic",
            Q_GIT_DIFF,
            "harvest",
            start_n,
            limit,
        )
    d = Path(tempfile.mkdtemp(prefix="condense-more-"))
    try:
        (d / "a.ts").write_text(
            """export type Id = number;
export function parse(s: string): Id { return s; }
parse(1);
const ids: Id[] = ["a", 2];
ids.map(x => x.trim());
"""
        )
        (d / "b.ts").write_text(
            """import { parse, Id } from "./a";
const id: Id = parse("x");
id.toLowerCase();
const m: Map<string, number> = new Map([[1, "a"]]);
"""
        )
        add_log(
            rows,
            run_cmd(["npx", "-y", "--package", "typescript", "tsc", "--noEmit", "--strict", str(d / "a.ts"), str(d / "b.ts")], d, 90),
            "typescript_check",
            Q_BUILD,
            "harvest-ts",
            start_n,
            limit,
        )
        (d / "main.tf").write_text(
            """
terraform {
  required_providers { local = { source = "hashicorp/local" } }
}
variable "force_destroy" { default = true }
resource "local_file" "bucket" {
  content  = "force_destroy=${var.force_destroy}"
  filename = "${path.module}/bucket.txt"
}
resource "local_file" "replica" {
  content  = "replica"
  filename = "${path.module}/replica.txt"
}
""".strip()
            + "\n"
        )
        run_cmd(["terraform", "init", "-input=false", "-no-color"], d, 90)
        add_log(rows, run_cmd(["terraform", "plan", "-input=false", "-no-color"], d, 90), "terraform_plan", Q_TF, "harvest-tf", start_n, limit)
        run_cmd(["terraform", "apply", "-input=false", "-auto-approve", "-no-color"], d, 90)
        (d / "main.tf").write_text(
            """
terraform {
  required_providers { local = { source = "hashicorp/local" } }
}
variable "force_destroy" { default = true }
resource "local_file" "bucket" {
  content  = "force_destroy=${var.force_destroy}"
  filename = "${path.module}/bucket-moved.txt"
}
""".strip()
            + "\n"
        )
        add_log(rows, run_cmd(["terraform", "plan", "-input=false", "-no-color"], d, 90), "terraform_plan", Q_TF, "harvest-tf", start_n, limit)
        add_log(rows, run_cmd(["terraform", "plan", "-destroy", "-input=false", "-no-color"], d, 90), "terraform_plan", Q_TF, "harvest-tf", start_n, limit)
        run_cmd(["terraform", "destroy", "-input=false", "-auto-approve", "-no-color"], d, 90)
        (d / "net.test.ts").write_text(
            """import { test, expect } from "bun:test";
test("retries timeout", () => { throw new Error("ECONNRESET host=api.internal"); });
test("parses 503", () => { expect(503).toBe(200); });
"""
        )
        add_log(rows, run_cmd(["bun", "test", str(d / "net.test.ts")], d, 60), "test_result", Q_TEST, "harvest-fail", start_n, limit)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def harvest_gap(rows: list[dict], start_n: int, limit: int) -> None:
    harvest_gap_typescript(rows, start_n, limit)
    harvest_gap_audit(rows, start_n, limit)
    harvest_gap_terraform(rows, start_n, limit)
    harvest_gap_docker_k8s(rows, start_n, limit)
    harvest_gap_extra(rows, start_n, limit)


def harvest_gap_typescript(rows: list[dict], start_n: int, limit: int) -> None:
    snippets: list[tuple[str, str]] = []
    for i, name in enumerate(
        ["auth", "api", "db", "cache", "queue", "http", "router", "store", "mail", "pay", "user", "job"]
    ):
        snippets.append(
            (
                f"{name}.ts",
                f"""type {name.title()} = {{ id: number; name: string }};
function load{i}(id: string): {name.title()} {{ return {{ id, name: {i} }}; }}
const row{i}: {name.title()} = load{i}({i});
row{i}.missing.toUpperCase();
const xs{i}: number[] = [row{i}.name, null];
""",
            )
        )
    snippets.extend(
        [
            (
                "promise.ts",
                "export async function load(url: URL): Promise<string> { return fetch(url); }\n"
                'load("/x");\nconst n: number = await load(new URL("http://x"));\n',
            ),
            (
                "union.ts",
                'type Ev = { t: "a"; n: number } | { t: "b"; s: string };\n'
                'function f(e: Ev) { return e.n.toFixed(1); }\n'
                'f({ t: "b", s: 1 });\n',
            ),
            (
                "generic.ts",
                "class Box<T> { constructor(public v: T) {} get(): T { return this.v as never; } }\n"
                'const b = new Box<number>("z");\nb.get().trim();\n',
            ),
            (
                "null.ts",
                "function len(s: string): number { return s.length; }\nlen(null);\nconst x: string = undefined;\n",
            ),
            (
                "excess.ts",
                "type P = { a: number };\nconst p: P = { a: 1, b: true };\nconst q: P = {};\n",
            ),
            (
                "enum.ts",
                'enum S { Ok = "ok", Err = "err" }\nconst s: S = "OK";\nfunction g(x: S): number { return x; }\n',
            ),
            (
                "index.ts",
                "interface Row { [k: string]: number }\nconst r: Row = { a: '1' };\nr.a.map(Boolean);\n",
            ),
            (
                "tuple.ts",
                "const t: [number, string] = ['1', 2];\nconst [a, b] = t;\na.toUpperCase();\n",
            ),
            (
                "class.ts",
                "class A { n: number = '1'; m(): string { return this.n; } }\nnew A().m().toFixed(1);\n",
            ),
            (
                "import-miss.ts",
                'import { missing } from "./nope";\nmissing(1);\n',
            ),
        ]
    )
    d = Path(tempfile.mkdtemp(prefix="condense-tsgap-"))
    try:
        for name, body in snippets:
            (d / name).write_text(body)
        add_log(
            rows,
            run_cmd(
                ["npx", "-y", "--package", "typescript", "tsc", "--noEmit", "--strict", *map(str, d.glob("*.ts"))],
                d,
                90,
            ),
            "typescript_check",
            Q_BUILD_GAP,
            "harvest-ts",
            start_n,
            limit,
        )
        for name, _body in snippets:
            if not room(rows, "typescript_check", start_n, limit):
                return
            add_log(
                rows,
                run_cmd(
                    ["npx", "-y", "--package", "typescript", "tsc", "--noEmit", "--strict", str(d / name)],
                    d,
                    90,
                ),
                "typescript_check",
                Q_BUILD_GAP,
                "harvest-ts",
                start_n,
                limit,
            )
        for left, right in zip(snippets[::2], snippets[1::2]):
            add_log(
                rows,
                run_cmd(
                    [
                        "npx",
                        "-y",
                        "--package",
                        "typescript",
                        "tsc",
                        "--noEmit",
                        "--strict",
                        str(d / left[0]),
                        str(d / right[0]),
                    ],
                    d,
                    90,
                ),
                "typescript_check",
                Q_BUILD_GAP,
                "harvest-ts",
                start_n,
                limit,
            )
    finally:
        shutil.rmtree(d, ignore_errors=True)


def harvest_gap_audit(rows: list[dict], start_n: int, limit: int) -> None:
    manifests = [
        {"name": "a-lodash", "dependencies": {"lodash": "4.17.4"}},
        {"name": "a-minimist", "dependencies": {"minimist": "0.0.8"}},
        {"name": "a-debug", "dependencies": {"debug": "2.6.8"}},
        {"name": "a-qs", "dependencies": {"qs": "6.5.1"}},
        {"name": "a-hoek", "dependencies": {"hoek": "4.2.0"}},
        {"name": "a-express", "dependencies": {"express": "4.16.0"}},
        {"name": "a-moment", "dependencies": {"moment": "2.19.3"}},
        {"name": "a-axios", "dependencies": {"axios": "0.18.0"}},
        {"name": "a-ws", "dependencies": {"ws": "5.2.0"}},
        {"name": "a-tar", "dependencies": {"tar": "2.2.1"}},
        {"name": "a-fetch", "dependencies": {"node-fetch": "1.7.3"}},
        {"name": "a-underscore", "dependencies": {"underscore": "1.8.3"}},
        {"name": "a-hbs", "dependencies": {"handlebars": "4.0.5"}},
        {"name": "a-jquery", "dependencies": {"jquery": "3.0.0"}},
        {"name": "a-serialize", "dependencies": {"serialize-javascript": "1.4.0"}},
        {"name": "a-mixin", "dependencies": {"mixin-deep": "1.3.0"}},
        {"name": "a-ini", "dependencies": {"ini": "1.3.5"}},
        {"name": "a-marked", "dependencies": {"marked": "0.3.19"}},
        {"name": "a-ejs", "dependencies": {"ejs": "2.6.1"}},
        {"name": "a-jwt", "dependencies": {"jsonwebtoken": "8.5.0"}},
        {"name": "a-glob", "dependencies": {"glob-parent": "5.1.0"}},
        {"name": "a-ansi", "dependencies": {"ansi-regex": "3.0.0"}},
        {"name": "a-nth", "dependencies": {"nth-check": "1.0.2"}},
        {"name": "a-mix1", "dependencies": {"lodash": "4.17.4", "minimist": "0.0.8", "debug": "2.6.8"}},
        {"name": "a-mix2", "dependencies": {"express": "4.16.0", "qs": "6.5.1", "axios": "0.18.0"}},
        {"name": "a-mix3", "dependencies": {"tar": "2.2.1", "ws": "5.2.0", "node-fetch": "1.7.3"}},
        {"name": "a-mix4", "dependencies": {"handlebars": "4.0.5", "ejs": "2.6.1", "marked": "0.3.19"}},
        {"name": "a-mix5", "dependencies": {"ini": "1.3.5", "mixin-deep": "1.3.0", "glob-parent": "5.1.0"}},
    ]
    for manifest in manifests:
        if not room(rows, "security_audit", start_n, limit):
            return
        d = Path(tempfile.mkdtemp(prefix="condense-auditg-"))
        try:
            (d / "package.json").write_text(json.dumps(manifest))
            lock = run_cmd(
                ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock-only"],
                d,
                90,
            )
            text = run_cmd(["npm", "audit"], d, 60)
            if "found 0 vulnerabilit" in text.lower() or "npm error" in text.lower():
                run_cmd(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"], d, 120)
                text = run_cmd(["npm", "audit"], d, 60)
            blob = run_cmd(["npm", "audit", "--json"], d, 60)
            add_log(rows, text, "security_audit", Q_AUDIT_GAP, "harvest-audit", start_n, limit)
            add_log(rows, blob, "security_audit", Q_AUDIT_GAP, "harvest-audit", start_n, limit)
            if "command failed" in lock:
                add_log(rows, lock, "security_audit", Q_AUDIT_GAP, "harvest-audit", start_n, limit)
        finally:
            shutil.rmtree(d, ignore_errors=True)


def harvest_gap_terraform(rows: list[dict], start_n: int, limit: int) -> None:
    header = """
terraform {
  required_version = ">= 1.0"
  required_providers { local = { source = "hashicorp/local" } }
}
""".strip()
    configs = [
        header
        + """
resource "local_file" "web" { content = "web-v1" filename = "${path.module}/web.txt" }
resource "local_file" "api" { content = "api-v1" filename = "${path.module}/api.txt" }
""",
        header
        + """
resource "local_file" "web" { content = "web-v2" filename = "${path.module}/web.txt" }
resource "local_file" "worker" { content = "worker" filename = "${path.module}/worker.txt" }
""",
        header
        + """
resource "local_file" "app" {
  count    = 4
  content  = "app-${count.index}"
  filename = "${path.module}/app-${count.index}.txt"
}
""",
        header
        + """
resource "local_file" "env" {
  for_each = toset(["dev", "stg", "prod"])
  content  = each.value
  filename = "${path.module}/${each.value}.txt"
}
""",
        header
        + """
resource "local_file" "bucket" {
  content  = "force_destroy=true"
  filename = "${path.module}/bucket.txt"
}
resource "local_file" "replica" {
  content  = "replica-az1"
  filename = "${path.module}/replica.txt"
}
""",
        header
        + """
resource "local_file" "secret" {
  content  = "rotate-me"
  filename = "${path.module}/secret.txt"
}
""",
        header
        + """
resource "local_file" "db" { content = "postgres" filename = "${path.module}/db.txt" }
resource "local_file" "cache" { content = "redis" filename = "${path.module}/cache.txt" }
resource "local_file" "queue" { content = "sqs" filename = "${path.module}/queue.txt" }
""",
        header
        + """
resource "local_file" "old" { content = "destroy-me" filename = "${path.module}/old.txt" }
""",
        """
terraform { required_providers { local = { source = "hashicorp/local" } } }
resource "local_file" "broken" { content = filename = "${path.module}/x.txt" }
""",
        header
        + """
resource "local_file" "badtype" { content = 123 filename = "${path.module}/n.txt" }
""",
        header
        + """
resource "not_a_resource" "x" { foo = "bar" }
""",
        header
        + """
resource "local_file" "keep" { content = "keep" filename = "${path.module}/keep.txt" }
resource "local_file" "gone" { content = "gone" filename = "${path.module}/gone.txt" }
""",
        header
        + """
resource "local_file" "keep" { content = "keep-v2" filename = "${path.module}/keep.txt" }
""",
        header
        + """
resource "local_file" "net" { content = "0.0.0.0/0" filename = "${path.module}/sg.txt" }
""",
        header
        + """
resource "local_file" "iam" { content = "AdministratorAccess" filename = "${path.module}/iam.txt" }
""",
        header
        + """
resource "local_file" "drop" { content = "DROP TABLE users;" filename = "${path.module}/sql.txt" }
""",
        header
        + """
resource "local_file" "a" { content = "a" filename = "${path.module}/a.txt" }
resource "local_file" "b" { content = "b" filename = "${path.module}/b.txt" }
resource "local_file" "c" { content = "c" filename = "${path.module}/c.txt" }
resource "local_file" "d" { content = "d" filename = "${path.module}/d.txt" }
""",
        header
        + """
resource "local_file" "moved" { content = "moved" filename = "${path.module}/moved.txt" }
""",
        header + "\n# empty stack after destroy\n",
        header
        + """
resource "local_file" "ttl" { content = "ttl=0" filename = "${path.module}/ttl.txt" }
""",
    ]
    d = Path(tempfile.mkdtemp(prefix="condense-tfgap-"))
    try:
        (d / "main.tf").write_text(configs[0] + "\n")
        run_cmd(["terraform", "init", "-input=false", "-no-color"], d, 90)
        for i, cfg in enumerate(configs):
            if not room(rows, "terraform_plan", start_n, limit):
                return
            (d / "main.tf").write_text(cfg.strip() + "\n")
            plan = run_cmd(["terraform", "plan", "-input=false", "-no-color"], d, 60)
            add_log(rows, plan, "terraform_plan", Q_TF, "harvest-tf", start_n, limit)
            applyable = "broken" not in cfg and "not_a_resource" not in cfg and "badtype" not in cfg
            if applyable and i % 2 == 0:
                apply = run_cmd(
                    ["terraform", "apply", "-input=false", "-auto-approve", "-no-color"], d, 60
                )
                add_log(rows, apply, "terraform_plan", Q_TF, "harvest-tf", start_n, limit)
                destroy = run_cmd(
                    ["terraform", "plan", "-destroy", "-input=false", "-no-color"], d, 60
                )
                add_log(rows, destroy, "terraform_plan", Q_TF, "harvest-tf", start_n, limit)
        run_cmd(["terraform", "destroy", "-input=false", "-auto-approve", "-no-color"], d, 60)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def harvest_gap_docker_k8s(rows: list[dict], start_n: int, limit: int) -> None:
    d = Path(tempfile.mkdtemp(prefix="condense-dkgap-"))
    try:
        dockerfiles = [
            "FROM alpine:3.20\nRUN echo compile-web && ls /nope/web && false\n",
            "FROM alpine:3.20\nRUN echo compile-api && cat /missing.conf\n",
            "FROM alpine:3.20\nRUN sh -c 'echo boom; exit 7'\n",
            "FROM alpine:3.20\nCOPY ./no-such-file /app/\n",
            "FROM alpine:3.20\nRUN adduser -D app && su app -c 'touch /root/x'\n",
            "FROM alpine:3.20\nEXPOSE not-a-port\nRUN false\n",
        ]
        for i, body in enumerate(dockerfiles):
            if not room(rows, "docker_k8s", start_n, limit):
                break
            (d / "Dockerfile").write_text(body)
            tag = f"condense-gap-{i}"
            out = run_cmd(["docker", "build", "-t", tag, str(d)], d, 90)
            add_log(rows, out, "docker_k8s", Q_DOCKER_GAP, "harvest-docker", start_n, limit)
            subprocess.run(["docker", "rmi", "-f", tag], capture_output=True, text=True)
        (d / "compose.yaml").write_text(
            "services:\n  web:\n    image: alpine:3.20\n    command: [sh, -c, 'echo crash; exit 9']\n"
            "  worker:\n    image: alpine:3.20\n    ports: [\"not-a-port:80\"]\n"
        )
        add_log(
            rows,
            run_cmd(["docker", "compose", "-f", str(d / "compose.yaml"), "config"], d, 30),
            "docker_k8s",
            Q_DOCKER_GAP,
            "harvest-docker",
            start_n,
            limit,
        )
        yamls = {
            "crash.yaml": """apiVersion: v1
kind: Pod
metadata: {name: worker-xy}
spec:
  containers:
    - name: worker
      image: ""
      command: ["boom"]
""",
            "mem.yaml": """apiVersion: v1
kind: Pod
metadata: {name: api-aa}
spec:
  containers:
    - name: api
      image: nginx
      resources: {limits: {memory: not-a-qty}}
""",
            "port.yaml": """apiVersion: v1
kind: Pod
metadata: {name: web}
spec:
  containers:
    - name: web
      image: nginx
      ports: [{containerPort: "http"}]
""",
            "deploy.yaml": """apiVersion: apps/v1
kind: Deployment
metadata: {name: api}
spec:
  replicas: "three"
  selector: {matchLabels: {app: api}}
  template:
    metadata: {labels: {app: api}}
    spec:
      containers: [{name: api, image: nginx}]
""",
            "svc.yaml": """apiVersion: v1
kind: Service
metadata: {name: api}
spec:
  selector: {app: missing}
  ports: [{port: 80, targetPort: nope}]
""",
            "job.yaml": """apiVersion: batch/v1
kind: Job
metadata: {name: job-zz}
spec:
  template:
    spec:
      restartPolicy: Never
      containers: [{name: job, image: alpine:3.20, command: ["false"]}]
""",
            "ingress.yaml": """apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: {name: web}
spec:
  rules: [{host: [], http: {paths: [{path: /, pathType: Prefix, backend: {service: {name: x, port: {number: 80}}}}]}}]
""",
            "pvc.yaml": """apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: data}
spec: {accessModes: [ReadWriteOnce], resources: {requests: {storage: abc}}}
""",
            "cm.yaml": """apiVersion: v1
kind: ConfigMap
metadata: {name: cfg}
data: {x: 1}
""",
            "sa.yaml": """apiVersion: v1
kind: ServiceAccount
metadata: {name: 123-invalid}
""",
            "netpol.yaml": """apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: deny}
spec:
  podSelector: {}
  policyTypes: [NotAType]
""",
            "hpa.yaml": """apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: {name: api}
spec:
  scaleTargetRef: {apiVersion: apps/v1, kind: Deployment, name: api}
  minReplicas: 5
  maxReplicas: 1
""",
            "cron.yaml": """apiVersion: batch/v1
kind: CronJob
metadata: {name: tick}
spec:
  schedule: "bad cron"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers: [{name: c, image: alpine:3.20, command: ["true"]}]
""",
            "sts.yaml": """apiVersion: apps/v1
kind: StatefulSet
metadata: {name: db}
spec:
  serviceName: db
  replicas: 1
  selector: {matchLabels: {app: db}}
  template:
    metadata: {labels: {app: other}}
    spec:
      containers: [{name: db, image: postgres:16}]
""",
            "quota.yaml": """apiVersion: v1
kind: ResourceQuota
metadata: {name: rq}
spec:
  hard: {pods: "none"}
""",
            "pdb.yaml": """apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: {name: api}
spec:
  minAvailable: 200%
  selector: {matchLabels: {app: api}}
""",
            "role.yaml": """apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: {name: r}
rules: [{apiGroups: [""], resources: ["pods"], verbs: ["not-a-verb"]}]
""",
            "missing.yaml": """apiVersion: v1
kind: Pod
metadata: {name: gone}
spec: {}
""",
            "multi.yaml": """apiVersion: v1
kind: Pod
metadata: {name: a}
---
apiVersion: v1
kind: Service
metadata: {name: a}
spec: {ports: [{port: "x"}]}
""",
            "init.yaml": """apiVersion: v1
kind: Pod
metadata: {name: init-bad}
spec:
  initContainers: [{name: i, image: ""}]
  containers: [{name: c, image: nginx}]
""",
        }
        for name, body in yamls.items():
            if not room(rows, "docker_k8s", start_n, limit):
                break
            (d / name).write_text(body)
            out = run_cmd(["kubectl", "apply", "--dry-run=client", "-f", str(d / name)], d, 20)
            add_log(rows, out, "docker_k8s", Q_K8S_GAP, "harvest-k8s", start_n, limit)
        add_log(
            rows,
            run_cmd(["kubectl", "apply", "--dry-run=client", "-f", str(d / "nope.yaml")], d, 20),
            "docker_k8s",
            Q_K8S_GAP,
            "harvest-k8s",
            start_n,
            limit,
        )
        add_log(
            rows,
            run_cmd(["docker", "ps", "-a", "--format", "{{.Names}} {{.Status}} {{.Image}}"], ROOT, 20),
            "docker_k8s",
            Q_DOCKER_GAP,
            "harvest-docker",
            start_n,
            limit,
        )
        add_log(
            rows,
            run_cmd(["docker", "inspect", "cli-proxy-api"], ROOT, 20),
            "docker_k8s",
            Q_DOCKER_GAP,
            "harvest-docker",
            start_n,
            limit,
        )
        add_log(
            rows,
            run_cmd(["docker", "logs", "--tail", "120", "cli-proxy-api"], ROOT, 20),
            "docker_k8s",
            Q_DOCKER_GAP,
            "harvest-docker",
            start_n,
            limit,
        )
    finally:
        shutil.rmtree(d, ignore_errors=True)


def harvest_gap_extra(rows: list[dict], start_n: int, limit: int) -> None:
    d = Path(tempfile.mkdtemp(prefix="condense-gapx-"))
    try:
        extras = []
        for i in range(16):
            extras.append(
                (
                    f"mod{i}.ts",
                    f"""export type Id{i} = number;
export function parse{i}(s: string): Id{i} {{ return s; }}
parse{i}({i});
const v{i}: Id{i}[] = ['{i}', {i}];
v{i}[0].toUpperCase();
""",
                )
            )
        for name, body in extras:
            (d / name).write_text(body)
            add_log(
                rows,
                run_cmd(
                    ["npx", "-y", "--package", "typescript", "tsc", "--noEmit", "--strict", str(d / name)],
                    d,
                    90,
                ),
                "typescript_check",
                Q_BUILD_GAP,
                "harvest-ts",
                start_n,
                limit,
            )
        add_log(
            rows,
            run_cmd(
                ["npx", "-y", "--package", "typescript", "tsc", "--noEmit", "--strict", *map(str, d.glob("mod*.ts"))],
                d,
                90,
            ),
            "typescript_check",
            Q_BUILD_GAP,
            "harvest-ts",
            start_n,
            limit,
        )

        header = """
terraform {
  required_providers { local = { source = "hashicorp/local" } }
}
""".strip()
        (d / "main.tf").write_text(header + '\nresource "local_file" "seed" { content = "s" filename = "${path.module}/s.txt" }\n')
        run_cmd(["terraform", "init", "-input=false", "-no-color"], d, 90)
        more_tf = [
            header
            + """
resource "local_file" "n" {
  count = 6
  content = "n-${count.index}"
  filename = "${path.module}/n-${count.index}.txt"
}
""",
            header
            + """
resource "local_file" "east" { content = "east" filename = "${path.module}/east.txt" }
resource "local_file" "west" { content = "west" filename = "${path.module}/west.txt" }
""",
            header
            + """
resource "local_file" "east" { content = "east-v2" filename = "${path.module}/east.txt" }
""",
            header
            + """
resource "local_file" "policy" { content = "s3:DeleteObject" filename = "${path.module}/policy.txt" }
""",
            header
            + """
resource "local_file" "kms" { content = "aws_kms_key.force_destroy=true" filename = "${path.module}/kms.txt" }
""",
            header
            + """
resource "local_file" "rds" { content = "skip_final_snapshot=true" filename = "${path.module}/rds.txt" }
""",
            header
            + """
resource "local_file" "acl" { content = "public-read" filename = "${path.module}/acl.txt" }
""",
            """
terraform { required_providers { local = { source = "hashicorp/local" } } }
resource "local_file" "x" { content = "${var.missing}" filename = "${path.module}/x.txt" }
""",
        ]
        for cfg in more_tf:
            if not room(rows, "terraform_plan", start_n, limit):
                break
            (d / "main.tf").write_text(cfg.strip() + "\n")
            plan = run_cmd(["terraform", "plan", "-input=false", "-no-color"], d, 60)
            add_log(rows, plan, "terraform_plan", Q_TF, "harvest-tf", start_n, limit)
            if "var.missing" not in cfg:
                apply = run_cmd(["terraform", "apply", "-input=false", "-auto-approve", "-no-color"], d, 60)
                add_log(rows, apply, "terraform_plan", Q_TF, "harvest-tf", start_n, limit)
                destroy = run_cmd(["terraform", "plan", "-destroy", "-input=false", "-no-color"], d, 60)
                add_log(rows, destroy, "terraform_plan", Q_TF, "harvest-tf", start_n, limit)
        run_cmd(["terraform", "destroy", "-input=false", "-auto-approve", "-no-color"], d, 60)

        more_yaml = {
            "ep.yaml": "apiVersion: v1\nkind: Endpoints\nmetadata: {name: api}\nsubsets: [{addresses: [{ip: not-an-ip}]}]\n",
            "limit.yaml": "apiVersion: v1\nkind: LimitRange\nmetadata: {name: lr}\nspec: {limits: [{type: Container, max: {cpu: abc}}]}\n",
            "lease.yaml": "apiVersion: coordination.k8s.io/v1\nkind: Lease\nmetadata: {name: l}\nspec: {holderIdentity: 1}\n",
            "ev.yaml": "apiVersion: v1\nkind: Event\nmetadata: {name: e}\ninvolvedObject: {kind: Pod, name: x}\nmessage: CrashLoopBackOff\nreason: BackOff\n",
            "ds.yaml": """apiVersion: apps/v1
kind: DaemonSet
metadata: {name: ds}
spec:
  selector: {matchLabels: {app: ds}}
  template:
    metadata: {labels: {app: other}}
    spec: {containers: [{name: c, image: nginx}]}
""",
        }
        for name, body in more_yaml.items():
            (d / name).write_text(body)
            add_log(
                rows,
                run_cmd(["kubectl", "apply", "--dry-run=client", "-f", str(d / name)], d, 20),
                "docker_k8s",
                Q_K8S_GAP,
                "harvest-k8s",
                start_n,
                limit,
            )
        for i, cmd in enumerate(
            [
                "echo web-fail; ls /opt/missing; exit 3",
                "echo api-fail; cat /etc/nope; exit 4",
                "echo worker-oom; exit 137",
            ]
        ):
            name = f"condense-gapx-{i}"
            subprocess.run(["docker", "rm", "-f", name], capture_output=True, text=True)
            out = run_cmd(["docker", "run", "--name", name, "alpine:3.20", "sh", "-c", cmd], ROOT, 60)
            add_log(rows, out, "docker_k8s", Q_DOCKER_GAP, "harvest-docker", start_n, limit)
            add_log(rows, run_cmd(["docker", "logs", name], ROOT, 20), "docker_k8s", Q_DOCKER_GAP, "harvest-docker", start_n, limit)
            subprocess.run(["docker", "rm", "-f", name], capture_output=True, text=True)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def harvest_git(rows: list[dict], start_n: int, limit: int) -> None:
    jobs = [
        (["git", "status"], Q_GIT_STATUS),
        (["git", "status", "-sb"], Q_GIT_STATUS),
        (["git", "log", "-8", "--oneline"], Q_GIT_LOG),
        (["git", "log", "-3", "--stat"], Q_GIT_LOG + Q_GIT_DIFF),
        (["git", "diff"], Q_GIT_DIFF),
        (["git", "diff", "--stat"], Q_GIT_DIFF),
        (["git", "show", "--stat", "--oneline", "-1"], Q_GIT_LOG + Q_GIT_DIFF),
        (["git", "branch", "-vv"], ["List local branches. Return name and tracking info, one per line."]),
    ]
    for argv, questions in jobs:
        add_log(rows, run_cmd(argv, ROOT, 30), "generic", questions, "harvest", start_n, limit)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=180)
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--only", choices=["all", "extra", "sparse", "volume", "more", "gap", "gapx"], default="all")
    args = parser.parse_args()
    rows = load_jsonl(args.out)
    for row in rows:
        if not row.get("source_hash") and row.get("input") is not None:
            row["source_hash"] = source_hash(row["input"])
    start_n = len(rows)
    if args.only == "all":
        harvest_fail_tests(rows, start_n, args.limit)
        harvest_typescript(rows, start_n, args.limit)
        harvest_npm_audit(rows, start_n, args.limit)
        harvest_terraform(rows, start_n, args.limit)
        harvest_github_actions(rows, start_n, args.limit)
        harvest_docker_k8s(rows, start_n, args.limit)
        harvest_git(rows, start_n, args.limit)
        harvest_more_fail_tests(rows, start_n, args.limit)
        harvest_more_typescript(rows, start_n, args.limit)
        harvest_terraform_replace(rows, start_n, args.limit)
        harvest_github_actions(rows, start_n, args.limit, CI_REPOS_EXTRA)
        harvest_docker_build(rows, start_n, args.limit)
        harvest_k8s_manifests(rows, start_n, args.limit)
        harvest_sparse(rows, start_n, args.limit)
        harvest_volume(rows, start_n, args.limit)
    elif args.only == "extra":
        harvest_more_fail_tests(rows, start_n, args.limit)
        harvest_more_typescript(rows, start_n, args.limit)
        harvest_terraform_replace(rows, start_n, args.limit)
        harvest_github_actions(rows, start_n, args.limit, CI_REPOS_EXTRA)
        harvest_docker_build(rows, start_n, args.limit)
        harvest_k8s_manifests(rows, start_n, args.limit)
    elif args.only == "sparse":
        harvest_sparse(rows, start_n, args.limit)
    elif args.only == "volume":
        harvest_volume(rows, start_n, args.limit)
    elif args.only == "more":
        harvest_more(rows, start_n, args.limit)
    elif args.only == "gap":
        TASK_CAPS.update(GAP_CAPS)
        harvest_gap(rows, start_n, args.limit)
    elif args.only == "gapx":
        TASK_CAPS.update(GAP_CAPS)
        harvest_gap_extra(rows, start_n, args.limit)
    write_jsonl(args.out, rows)
    tasks: dict[str, int] = {}
    for row in rows:
        tasks[row.get("task") or "generic"] = tasks.get(row.get("task") or "generic", 0) + 1
    sources = {row.get("source_hash") for row in rows}
    print(
        f"pairs {start_n} -> {len(rows)} added {len(rows) - start_n} "
        f"unique_sources {len(sources)}"
    )
    print("by_task", json.dumps(tasks, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

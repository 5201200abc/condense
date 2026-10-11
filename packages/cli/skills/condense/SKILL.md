---
name: condense
description: Compress lengthy test, compiler, and deployment logs with Condense while preserving failures, original errors, risks, and source locations. Use when a task benefits from a log summary; skip when exact full output is needed.
---

# Condense

Use Condense to reduce noisy execution logs for the current task. Keep the user's language and requested answer format. This skill does not change the conversation style or apply to unrelated commands.

## When to use it

Prefer Condense for lengthy test, compiler, and deployment logs when the agent needs a status or error summary. The runtime bypasses short logs (at most 100 lines and 4,000 characters) and dense source dumps. Read source files, diffs, interactive/TUI output, and exact artifacts directly.

State what must survive: failing items, original error messages, file/line locations, or destructive changes. Preserve the command's exit status:

```bash
set -o pipefail
<test command> 2>&1 | condense "PASS or FAIL? List failing items with their relevant raw error messages."
```

For a deployment plan:

```bash
set -o pipefail
<plan command> 2>&1 | condense "SAFE or UNSAFE? List risky changes with their original evidence."
```

## Reliability

Condense scans the full input for critical evidence before applying the local 8K character budget. It checks supported failure/risk contracts and explicit successful outcomes. A false failure verdict on a confirmed successful run is corrected using original outcome statistics and recorded separately from dropped errors. Conflicting or insufficient evidence returns the original log rather than forcing a verdict. Incomplete failure answers use a shorter deterministic evidence excerpt when possible; otherwise the original log is returned.

Read the delivered result before acting. If a summary does not answer the task or more surrounding context is needed, use `condense recall <request-id>` to inspect the captured original log. `condense stats -H` lists recent suspect request IDs; `condense stats --json` exposes measured quality and savings. Runs without quality measurements are unassessed.

`condense warmup` prepares the configured local backend. Local execution requires the v2 GGUF and llama.cpp runtime; an explicitly configured external provider uses its own model service. Follow the installation instructions for the deployed package.

DSL and translation commands remain available when explicitly useful; this skill does not require them, automatic transcript learning, or compressed conversation language.

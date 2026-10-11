<div align="center">
  <img src="./assets/logo.svg" alt="condense logo" width="112" height="112" style="display: block; margin: 0 auto;" />
  <h1 style="margin: 4px 0 8px 0; padding: 0; border-bottom: none;">condense</h1>
  <p style="margin: 0 0 12px 0;"><strong>Keep long, noisy tool logs inside the frontier model's context. Locally.</strong></p>

  <p style="margin: 0 0 16px 0;">
    <a href="https://github.com/5201200abc/condense/releases"><img src="https://img.shields.io/github/v/release/5201200abc/condense?color=brightgreen" alt="Release" /></a>
    <a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License: Apache 2.0" /></a>
    <a href="https://github.com/5201200abc/condense"><img src="https://img.shields.io/badge/Model-condense--0.8B--Q4-yellow" alt="Local model" /></a>
    <a href="https://github.com/5201200abc/condense"><img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-555.svg" alt="Platform" /></a>
  </p>

  <p><code>condense</code> compresses high-volume, low-density logs (tests, compilers, terraform). Short commands, source, diffs, and whole-repo dumps pass through.</p>
  <p>Local model: Condense 0.8B Q4_K_M GGUF (~505 MB) on resident llama.cpp. Thinking off. Compact system prompt. <code>cache_prompt</code> enabled.</p>
</div>

---

## Installation

This project's npm packages are not published. Public npm `condense` belongs to a different project. Install from this checkout:

```bash
./install.sh
condense warmup
```

`install.sh` compiles a local binary if npm is not this project. The local model must already be available: place `train/gguf/v2/condense-0.8B-Q4_K_M.gguf` at `~/.config/condense/models/` or set `CONDENSE_LLAMA_GGUF`. Skip warmup with `CONDENSE_SKIP_WARMUP=1`. `condense update` checks npm; npm installation and upgrades remain unverified until this project is published.

## Agent setup

`condense onboard` installs the [Condense Skill](skills/condense/SKILL.md) and adds only this optional routing hint to `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`:

```text
<!-- condense skill: begin -->
For lengthy test, compiler, or deployment logs, consider the condense skill when a summary serves the task and exact full output is unnecessary.
<!-- condense skill: end -->
```

## Usage

```bash
bun test 2>&1 | condense "Did tests pass? Return PASS or FAIL, with failing test files."
npx tsc --noEmit 2>&1 | condense "Did build succeed? List exact error files and line numbers."
terraform plan 2>&1 | condense "Is this safe? Return SAFE, REVIEW, or UNSAFE and the risky changes."
```

```bash
condense stats
condense stats -H
condense stats --project
condense stats --json
condense stats --days 7
bun test 2>&1 | condense --stats "Did tests pass?"
```

Before applying the 8K local input budget, Condense scans the full log for failure, risk, and explicit successful outcomes. Runtime checks preserve original errors, failing items, locator diagnostics, and actionable source locations. Incorrect failure verdicts on confirmed successful runs are replaced with PASS and original outcome statistics. Conflicting or insufficient evidence returns the original log instead of forcing a verdict. Incomplete failure answers use a shorter deterministic evidence excerpt when possible; raw fallbacks receive no compression credit.

Stats reports measured outcome contract pass rates, critical failure evidence recall, effective estimated tokens saved, Guard repairs, abandoned savings, and end-to-end P95 latency. False failure verdicts are recorded separately from dropped errors. Historical runs without quality measurements remain unassessed.

## License

Apache License 2.0. See [LICENSE](./LICENSE) for details.

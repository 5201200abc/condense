<div align="center">
  <img src="./assets/logo.svg" alt="condense logo" width="112" height="112" style="display: block; margin: 0 auto;" />
  <h1 style="margin: 4px 0 8px 0; padding: 0; border-bottom: none;">condense</h1>
  <p style="margin: 0 0 12px 0;"><strong>Keep long, noisy tool logs inside the frontier model's context. Locally.</strong></p>

  <p style="margin: 0 0 16px 0;">
    <a href="https://www.npmjs.com/package/condense"><img src="https://img.shields.io/npm/v/condense?color=blue&label=npm" alt="npm version" /></a>
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

CLI updates go through npm after CI publishes this package. There is no GitHub tarball.

```bash
npm install -g condense
# or
bun add -g condense
condense warmup
```

`condense update` checks npm and prints `npm install -g condense@latest` when this project is the published package. Until CI has published it, public npm `condense` is a different project.

From a checkout, `install.sh` compiles a local binary if npm is not this project. Place `train/gguf/v2/condense-0.8B-Q4_K_M.gguf` at `~/.config/condense/models/` or set `CONDENSE_LLAMA_GGUF`. Skip warmup with `CONDENSE_SKIP_WARMUP=1`.

## Agent setup

Paste the same block into `~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md`:

```text
<!-- condense -->
Pipe high-volume, low-density logs through condense (>100 lines: tests, compilers, terraform):
<cmd> 2>&1 | condense "<explicit question>. Return only the required result and relevant raw error lines."
For tests/compilers:
<cmd> 2>&1 | condense "PASS or FAIL? List failed names and the first raw error line for each."
Skip short commands, TUI, source files, git diffs, and whole-repo/architecture dumps.
Skip when exact raw output is required.
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

## License

Apache License 2.0. See [LICENSE](./LICENSE) for details.

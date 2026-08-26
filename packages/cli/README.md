<div align="center">
  <img src="./assets/logo.svg" alt="condense logo" width="112" height="112" style="display: block; margin: 0 auto;" />
  <h1 style="margin: 4px 0 8px 0; padding: 0; border-bottom: none;">condense</h1>
  <p style="margin: 0 0 12px 0;"><strong>Fast, local terminal output compression for coding agents and LLMs.</strong></p>

  <p style="margin: 0 0 16px 0;">
    <a href="https://www.npmjs.com/package/condense"><img src="https://img.shields.io/npm/v/condense?color=blue&label=npm" alt="npm version" /></a>
    <a href="https://github.com/5201200abc/condense/releases"><img src="https://img.shields.io/github/v/release/5201200abc/condense?color=brightgreen" alt="Release" /></a>
    <a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License: Apache 2.0" /></a>
    <a href="https://huggingface.co/samuelfaj/distill2-0.6B-4bit-MLX"><img src="https://img.shields.io/badge/Model-distill2--0.6B-yellow" alt="HuggingFace Model" /></a>
    <a href="https://github.com/5201200abc/condense"><img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-555.svg" alt="Platform" /></a>
  </p>

  <p><code>condense</code> filters noisy terminal output (test runners, build logs, linter diagnostics, stack traces) locally via a streaming pipeline, passing only critical semantic information to downstream agents and eliminating over 90% of context window bloat.</p>
  <p>Model source: <a href="https://huggingface.co/samuelfaj/distill2-0.6B-4bit-MLX">distill2-0.6B 4-bit quantized model</a> (only 404 MB model weights, 98.4% accuracy).</p>
</div>

---

## Installation

### Quick Install (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/5201200abc/condense/main/install.sh | sh
```

### Homebrew

```bash
brew install 5201200abc/tap/condense
```

### Package Managers

```bash
npm install -g condense
# or
bun add -g condense
```

## Upgrade

To upgrade `condense` to the latest version:

### Quick Install (Script)

```bash
curl -fsSL https://raw.githubusercontent.com/5201200abc/condense/main/install.sh | sh
```

### Homebrew

```bash
brew update && brew upgrade 5201200abc/tap/condense
```

### Package Managers

```bash
npm install -g condense@latest
# or
bun add -g condense@latest
```

### CLI Check

```bash
condense update
```

Add the following minimal directive to `~/.claude/CLAUDE.md`:
```text
<!-- condense -->
Pipe high-volume commands (>100 lines: test runners, compiler logs, plans) through condense:
<cmd> 2>&1 | condense "Did tests pass? Return PASS/FAIL and failed test names."
Skip for interactive/TUI or short outputs.
```

Add the following directive to `~/.codex/AGENTS.md`:
```text
<!-- condense -->
Pipe high-volume commands (>100 lines: test suites, build/tsc logs, terraform) through condense:
<cmd> 2>&1 | condense "<explicit question>"
Never use condense for small commands (cat, sed, pwd, ls, file reads).
```

### Pipeline Usage
```bash
# Test runner output
bun test 2>&1 | condense "Did tests pass? Return PASS or FAIL, with failing test files."

# Compiler diagnostics
npx tsc --noEmit 2>&1 | condense "Did build succeed? List exact error files and line numbers."

# Git diff summary
git diff 2>&1 | condense "What changed? Return only modified files and summary."
```

### Character Savings and Metrics

Track how many characters and lines `condense` has saved across your workflow:

```bash
# View global summary of saved characters, lines, and compression ratio
condense stats

# View summary with detailed history of recent compression commands
condense stats -H

# Filter metrics for the current project
condense stats --project

# Output metrics in JSON format
condense stats --json

# Filter metrics for the last N days
condense stats --days 7

# Print per-execution character savings to stderr alongside pipeline output
bun test 2>&1 | condense --stats "Did tests pass?"
```

---

## Benchmark Results

Real-world test data measured on live hardware:

| Scenario | Input (Est.) | Output | Token Compression | Latency | Result & Accuracy |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **Unit Test Failures** | 360 tokens | 1 token | **99.6%** | **0.41s** | Filters all passing tests, returns only `FAIL test/auth.test.ts` |
| **TypeScript Errors** | 187 tokens | 83 tokens | **55.1%** | **0.88s** | Extracts exact error files, line numbers, and error codes (`TS2339`, `TS2322`) |
| **Terraform Plan** | 248 tokens | 28 tokens | **88.6%** | **0.61s** | Detects destructive database recreation and emits `UNSAFE` verdict |
| **Large Git Diff** | 39 modified files | 3 lines | **95.2%** | **0.48s** | Filters code diffs, emits concise modified file list and summary |

## License

Apache License 2.0. See [LICENSE](./LICENSE) for details.

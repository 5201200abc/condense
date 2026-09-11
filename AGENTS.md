# Condense

After a task is finished, clean build cache artifacts before stopping.

Delete what this session created or left in the repo:

- `.dist/`
- `dist/`
- `coverage/`
- `*.bun-build` and `.*.bun-build`
- `train/**/__pycache__/` and `*.pyc`
- leftover `*.tgz` pack files under the repo root

Do not delete shipped platform binaries, current v2 GGUF, or `~/.config/condense/` (`stats.json`, `observe.jsonl`, models).

import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { pidIsAlive, withFileLock } from "../src/file-lock";

describe("file lock", () => {
  it("steals a lock whose PID is dead", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-lock-"));
    const lockPath = path.join(dir, "lock");

    try {
      await writeFile(lockPath, "99999999\n");
      const result = await withFileLock(lockPath, async () => {
        expect(pidIsAlive(process.pid)).toBe(true);
        return "ok";
      }, { timeoutMs: 1_000, pollMs: 10 });

      expect(result).toBe("ok");
      await expect(readFile(lockPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("times out while a live PID holds the lock", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-lock-"));
    const lockPath = path.join(dir, "lock");

    try {
      await writeFile(lockPath, `${process.pid}\n`);
      await expect(
        withFileLock(lockPath, async () => "never", {
          timeoutMs: 80,
          pollMs: 10
        })
      ).rejects.toThrow("Timed out waiting for lock");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

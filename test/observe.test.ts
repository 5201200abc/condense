import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendObserveRecord,
  buildObserveRecord,
  detectSuspectReasons
} from "../src/observe";

function longFailLog(): string {
  const passes = Array.from({ length: 120 }, (_, i) => `PASS test/ok${i}.test.ts`);
  return `${passes.join("\n")}\nFAIL test/auth.test.ts\n`;
}

describe("observe", () => {
  it("flags mixed PASS/FAIL summarized as PASS", () => {
    expect(
      detectSuspectReasons(longFailLog(), "PASS")
    ).toContain("mixed_pass_fail");
  });

  it("flags terraform destroy reported SAFE", () => {
    const plan = `${"  # aws_db_instance.main will be destroyed\n".repeat(80)}Plan: 0 to add, 0 to change, 1 to destroy.\n`;
    expect(detectSuspectReasons(plan, "SAFE")).toContain("terraform_destructive");
  });

  it("flags empty CI timeout reported FAIL", () => {
    expect(
      detectSuspectReasons("gh run: timed out waiting for CI result\n", "FAIL")
    ).toContain("empty_as_fail");
  });

  it("flags long-log errors missing from the summary", () => {
    const log = `${"src/app.ts(10,1): error TS2339: x\n".repeat(80)}src/db.ts(4,2): error TS2322: y\n`;
    expect(detectSuspectReasons(log, "FAIL src/app.ts")).toContain("missed_critical");
  });

  it("records long compressed logs and writes jsonl", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-observe-"));
    const env = { CONDENSE_OBSERVE_PATH: path.join(dir, "observe.jsonl") };
    const raw = longFailLog();
    try {
      const record = buildObserveRecord({
        requestId: "req_test_001",
        question: "Did tests pass? Return PASS or FAIL.",
        rawInput: raw,
        modelInput: raw,
        output: "FAIL test/auth.test.ts",
        inputLines: raw.split("\n").length
      });
      expect(record?.kinds).toContain("long");
      expect(record?.kinds).not.toContain("suspect");
      expect(record?.requestId).toBe("req_test_001");
      expect(record?.rawEstimatedTokens).toBeGreaterThan(0);
      expect(record?.outputEstimatedTokens).toBeGreaterThan(0);
      await appendObserveRecord(env, record!);
      const lines = (await readFile(env.CONDENSE_OBSERVE_PATH, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!);
      expect(parsed.kinds).toContain("long");
      expect(parsed.requestId).toBe("req_test_001");
      expect(parsed.rawEstimatedTokens).toBeGreaterThan(0);
      expect(parsed.outputEstimatedTokens).toBeGreaterThan(0);
      expect(parsed.input).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

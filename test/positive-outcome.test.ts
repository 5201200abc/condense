import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { enforceEvidenceContract } from "../src/evidence";
import { CondenseSession } from "../src/stream-condenser";
import { readObserveRecords } from "../src/observe";
import { formatStatsReport, readStatsFile } from "../src/stats";

const question = "PASS or FAIL? List failing items with their relevant raw error messages.";
const noise = "[info] background task finished\n".repeat(200);
const success = "Tests: 48 passed, 0 failed\nProcess completed with exit code 0.\n";
const fabricated = 'FAIL\nError: "Tests: 48 passed, 0 failed"\nError: "source: /tmp/fabricated.json"';

describe("positive outcome guard", () => {
  for (const reference of [
    "WARNING: Error: retry failed once; recovered",
    "WARNING: recovered from TimeoutError: retry succeeded",
    "[history] Error: failed in a previous run",
    "historical reference: locator.click: Timeout 45000ms exceeded.",
    "documentation example: TypeError: this is not a current error"
  ]) {
    it(`protects current successful outcomes despite ${reference}`, () => {
      const raw = noise + reference + "\n" + success;
      const result = enforceEvidenceContract(raw, fabricated, question);
      expect(result.output).toStartWith("PASS\n");
      expect(result.output).toContain("Tests: 48 passed, 0 failed");
      expect(result.output).toContain("Process completed with exit code 0.");
      expect(result.output).not.toContain("Error:");
      expect(result.output).not.toContain("fabricated.json");
      expect(result.quality?.rejectionReason).toBe("false_failure");
      expect(result.quality?.modelContractPassed).toBe(false);
    });
  }

  for (const signal of [
    "Error: actual execution failed\n" + success,
    "Tests: 48 passed, 1 failed\n" + success,
    "Tests: 48 passed, 1 failed\nProcess completed with exit code 0.\n",
    "Tests: 47 passed, 0 failed\n" + success,
    "Process completed with exit code 1.\n" + success
  ]) {
    for (const verdict of ["PASS", "FAIL"]) {
      it(`does not force ${verdict} on conflicting outcomes: ${signal.split("\n")[0]}`, () => {
        const raw = noise + signal;
        const result = enforceEvidenceContract(raw, verdict, question);
        expect(result.output).toBe(raw);
        expect(result.quality?.rejectionReason).toBe("conflicting_outcomes");
        expect(result.quality?.contractPassed).toBe(false);
        expect(result.quality?.action).toBe("raw");
      });
    }
  }

  for (const signal of [
    "WARNING: TimeoutError was mentioned, but execution outcome is unknown\n",
    "Tests: 0 passed, 0 failed\nProcess completed with exit code 0.\n",
    "no tests ran\nProcess completed with exit code 0.\n",
    "Process completed with exit code 0.\n"
  ]) {
    it(`does not infer test success without sufficient evidence: ${signal.split("\n")[0]}`, () => {
      const raw = noise + signal;
      for (const verdict of ["PASS", "FAIL"]) {
        const result = enforceEvidenceContract(raw, verdict, "Did tests pass? Return PASS or FAIL.");
        expect(result.output).toBe(raw);
        expect(result.quality?.rejectionReason).toBe("unverified_outcome");
      }
    });
  }

  it("preserves real failure evidence with a nonzero exit", () => {
    const result = enforceEvidenceContract(noise + "locator.click: Timeout 30000ms exceeded.\nProcess completed with exit code 1.\n", "PASS", question);
    expect(result.output).toStartWith("FAIL\n");
    expect(result.output).toContain("locator.click: Timeout 30000ms exceeded.");
    expect(result.quality?.rejectionReason).toBeUndefined();
  });

  it("accepts an explicit insufficient-information answer without asserting a verdict", () => {
    const output = "condense: Insufficient information to output anything.";
    expect(enforceEvidenceContract(noise, output, "Return PASS or FAIL.").output).toBe(output);
  });

  it("respects status-only output and rejects fabricated errors after a correct positive verdict", () => {
    expect(enforceEvidenceContract(noise + success, "FAIL", "Return only PASS or FAIL.").output).toBe("PASS");
    expect(enforceEvidenceContract(noise + success, "PASS\nError: fabricated", question).output).not.toContain("fabricated");
    expect(enforceEvidenceContract(noise + success, "PASS", question).quality?.action).toBe("none");
  });

  it("protects an explicitly unchanged Terraform plan", () => {
    const input = noise + "No changes. Your infrastructure matches the configuration.\nPlan: 0 to add, 0 to change, 0 to destroy.\n";
    const result = enforceEvidenceContract(input, "UNSAFE", "SAFE or UNSAFE? List risky changes.");
    expect(result.output).toStartWith("SAFE\n");
    expect(result.output).toContain("Plan: 0 to add, 0 to change, 0 to destroy.");
    expect(result.quality?.rejectionReason).toBe("false_failure");
  });

  it("records false_failure separately in Observe, Reliability and model contract rates", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-positive-"));
    const env = { CONDENSE_STATS_PATH: path.join(dir, "stats.json"), CONDENSE_OBSERVE_PATH: path.join(dir, "observe.jsonl"), CONDENSE_RECALL_PATH: path.join(dir, "recall.db") };
    const chunks: Buffer[] = [];
    try {
      const session = new CondenseSession({
        env, cwd: dir, isTTY: false,
        stdout: { write: (chunk) => { chunks.push(Buffer.from(chunk)); return true; } },
        runtimeConfig: { question, model: "v2", host: "http://localhost:8009/v1", apiKey: "", timeoutMs: 1000 },
        summarizer: { summarizeBatch: async () => fabricated, summarizeWatch: async () => fabricated }
      });
      session.push(Buffer.from(noise + success));
      await session.end();
      expect(Buffer.concat(chunks).toString()).toStartWith("PASS\n");
      const stats = await readStatsFile(env), records = await readObserveRecords(env);
      expect(records[0].suspectReasons).toEqual(["false_failure"]);
      expect(stats.recent[0].suspect).toEqual(["false_failure"]);
      for (const observeRecords of [records, undefined]) {
        const report = JSON.parse(formatStatsReport(stats, { json: true, observeRecords }));
        expect(report.suspectReasons.falseFailure).toBe(1);
        expect(report.suspectReasons.droppedError).toBe(0);
        expect(report.quality.falseFailures).toBe(1);
        expect(report.quality.contractPassRate).toBe(100);
        expect(report.quality.modelContractPassRate).toBe(0);
        expect(report.quality.effectiveTokensSaved).toBeGreaterThan(0);
      }
      expect(formatStatsReport(stats, { observeRecords: records })).toContain("False failure");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

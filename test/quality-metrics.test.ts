import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildObserveRecord } from "../src/observe";
import { formatStatsReport, readStatsFile } from "../src/stats";

it("counts quality-checked savings and P95 without treating raw fallback or legacy records as successful compression", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "condense-quality-"));
  try {
    const stats = await readStatsFile({ CONDENSE_STATS_PATH: path.join(dir, "stats.json") });
    const raw = "info\n".repeat(100) + "Error: failed\n";
    const records = Array.from({ length: 20 }, (_, i) => ({
      ...buildObserveRecord({ requestId: `valid-${i}`, question: "List errors", rawInput: raw,
        output: "FAIL\nError: failed", inputLines: 102 }),
      quality: { contractPassed: true, modelContractPassed: i !== 0, required: 1, retained: 1,
        action: i === 0 ? "repair" as const : "none" as const, abandonedTokens: i === 0 ? 5 : 0 },
      endToEndMs: (i + 1) * 10
    }));
    const fallback = {
      ...buildObserveRecord({ requestId: "fallback", question: "List errors", rawInput: raw, output: raw, inputLines: 102 }),
      quality: { contractPassed: true, modelContractPassed: false, required: 1, retained: 1, action: "raw" as const },
      endToEndMs: 9999
    };
    const legacy = buildObserveRecord({ requestId: "legacy", question: "List errors", rawInput: raw, output: "FAIL", inputLines: 102 });
    const report = JSON.parse(formatStatsReport(stats, { json: true, observeRecords: [...records, fallback, legacy] }));
    expect(report.quality.assessed).toBe(21);
    expect(report.quality.contractPassRate).toBe(100);
    expect(report.quality.modelContractPassRate).toBe(90.48);
    expect(report.quality.criticalEvidenceRecall).toBe(100);
    expect(report.quality.guardRepairs).toBe(1);
    expect(report.quality.rawFallbacks).toBe(1);
    expect(report.quality.abandonedTokens).toBe(5);
    expect(report.quality.endToEndP95Ms).toBe(190);
    expect(report.quality.effectiveTokensSaved).toBe(records.reduce((sum, r) => sum + r.rawEstimatedTokens - r.outputEstimatedTokens, 0));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

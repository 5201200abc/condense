import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fixtures from "./fixtures/v2-failure-contract.json";
import { hasIncompleteFailureDetails, INCOMPLETE_FAILURE_DETAILS } from "../src/text";
import { fitInput, LOCAL_MAX_INPUT_CHARS } from "../src/prompt";
import { normalizeForModel } from "../src/text";
import { CondenseSession } from "../src/stream-condenser";
import { readObserveRecords } from "../src/observe";
import { formatStatsReport, readStatsFile } from "../src/stats";

describe("v2 failure output contract", () => {
  for (const fixture of fixtures) {
    it(`rejects bare FAIL and preserves production evidence ${fixture.request_id.slice(0, 8)}`, async () => {
      const modelInput = fitInput(normalizeForModel(fixture.raw_input), LOCAL_MAX_INPUT_CHARS);
      expect(hasIncompleteFailureDetails(modelInput, fixture.output, fixture.question)).toBe(true);
      const dir = await mkdtemp(path.join(tmpdir(), "condense-contract-"));
      const env = {
        CONDENSE_STATS_PATH: path.join(dir, "stats.json"),
        CONDENSE_OBSERVE_PATH: path.join(dir, "observe.jsonl"),
        CONDENSE_RECALL_PATH: path.join(dir, "recall.db")
      };
      const chunks: Buffer[] = [];
      try {
        const session = new CondenseSession({
          env,
          cwd: dir,
          isTTY: false,
          stdout: { write: (chunk) => { chunks.push(Buffer.from(chunk)); return true; } },
          runtimeConfig: {
            question: fixture.question, model: "v2", host: "http://localhost:8009/v1",
            apiKey: "", timeoutMs: 1000, datasetEnabled: true
          },
          dataset: { enabled: true, path: path.join(dir, "dataset.jsonl") },
          summarizer: {
            summarizeBatch: async () => fixture.output,
            summarizeWatch: async () => fixture.output
          }
        });
        session.push(Buffer.from(fixture.raw_input));
        await session.end();
        expect(Buffer.concat(chunks).toString()).toBe(fixture.raw_input);
        await expect(readFile(path.join(dir, "dataset.jsonl"))).rejects.toThrow();
        const stats = await readStatsFile(env);
        const records = await readObserveRecords(env);
        expect(stats.totals.savedTokens).toBe(0);
        expect(stats.totals.savedChars).toBe(0);
        expect(stats.totals.suspectCalls).toBe(1);
        expect(records[0].suspectReasons).toEqual([INCOMPLETE_FAILURE_DETAILS]);
        expect(records[0].output).toBe(fixture.raw_input);
        for (const observeRecords of [records, undefined]) {
          const report = JSON.parse(formatStatsReport(stats, { json: true, observeRecords }));
          expect(report.compressed).toBe(0);
          expect(report.freedEstimatedTokens).toBe(0);
          expect(report.suspects).toBe(1);
          expect(report.suspectReasons.droppedError).toBe(1);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  it("allows status-only questions and summaries with details", () => {
    const input = fixtures[0].raw_input;
    expect(hasIncompleteFailureDetails(input, "FAIL", "PASS or FAIL?")).toBe(false);
    expect(hasIncompleteFailureDetails(input, "FAIL")).toBe(false);
    expect(hasIncompleteFailureDetails(input, "FAIL: locator.click timed out", fixtures[0].question)).toBe(false);
  });

  it("requires execution failure evidence rather than ordinary warnings", () => {
    const question = fixtures[0].question;
    expect(hasIncompleteFailureDetails("WARNING: notification poll failed after 1000ms", "FAIL", question)).toBe(false);
    expect(hasIncompleteFailureDetails("WARNING: connection timed out", "FAIL", question)).toBe(false);
    expect(hasIncompleteFailureDetails("[console.warn] recovered from TimeoutError", "FAIL", question)).toBe(false);
    expect(hasIncompleteFailureDetails("AssertionError [ERR_ASSERTION]: expected true\n    at verify (/tmp/check.mjs:2:3)", "FAIL", question)).toBe(true);
    expect(hasIncompleteFailureDetails("  name: 'TimeoutError'", "FAIL", "列出失败项及原始错误")).toBe(true);
  });
});

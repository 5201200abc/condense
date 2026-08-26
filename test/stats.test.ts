import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  formatSingleRunSummary,
  formatStatsReport,
  readStatsFile,
  recordCondenseRun,
  resetStats,
  resolveStatsPath,
  runStatsCommand,
  writeStatsFile,
  type StatsStorageFile
} from "../src/stats";
import { CondenseSession } from "../src/stream-condenser";
import { UsageError } from "../src/config";

const EMOJI_REGEX =
  /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}]/u;

describe("stats module", () => {
  it("reads empty stats when file does not exist", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-stats-test-"));
    const env = { CONDENSE_CONFIG_PATH: path.join(dir, "config.json") };

    try {
      const stats = await readStatsFile(env);
      expect(stats.version).toBe(1);
      expect(stats.totals.calls).toBe(0);
      expect(stats.totals.savedChars).toBe(0);
      expect(stats.totals.savedLines).toBe(0);
      expect(stats.recent).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records character and line savings accurately", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-stats-test-"));
    const env = { CONDENSE_CONFIG_PATH: path.join(dir, "config.json") };
    const fixedDate = new Date("2026-08-25T12:00:00.000Z");

    try {
      const rawInput = "PASS test/auth.test.ts\nFAIL test/user.test.ts\n  expected true, got false\n1 passed, 1 failed";
      const output = "FAIL test/user.test.ts";

      const run = await recordCondenseRun(env, {
        cwd: "/Users/test/my-project",
        question: "Did tests pass?",
        rawInput,
        output,
        durationMs: 345,
        now: fixedDate
      });

      expect(run.inputChars).toBe(rawInput.length);
      expect(run.outputChars).toBe(output.length);
      expect(run.inputLines).toBe(4);
      expect(run.outputLines).toBe(1);
      expect(run.savedLines).toBe(3);
      expect(run.savedChars).toBe(rawInput.length - output.length);
      expect(run.durationMs).toBe(345);
      expect(run.charCompressionRatio).toBe(
        Number((((rawInput.length - output.length) / rawInput.length) * 100).toFixed(2))
      );

      const stats = await readStatsFile(env, fixedDate);
      expect(stats.totals.calls).toBe(1);
      expect(stats.totals.savedChars).toBe(run.savedChars);
      expect(stats.totals.savedLines).toBe(run.savedLines);
      expect(stats.totals.durationMs).toBe(345);
      expect(stats.daily["2026-08-25"].calls).toBe(1);
      expect(stats.recent).toHaveLength(1);
      expect(stats.recent[0].savedChars).toBe(run.savedChars);

      const statsPath = resolveStatsPath(env);
      const fileStat = await stat(statsPath);
      expect(fileStat.mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accumulates multiple runs across different projects", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-stats-test-"));
    const env = { CONDENSE_CONFIG_PATH: path.join(dir, "config.json") };

    try {
      await recordCondenseRun(env, {
        cwd: "/project-a",
        question: "Did tests pass?",
        rawInput: "line 1\nline 2\nline 3\nline 4\nline 5",
        output: "FAIL",
        durationMs: 200
      });

      await recordCondenseRun(env, {
        cwd: "/project-b",
        question: "What are the typescript errors?",
        rawInput: "error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/index.ts:10",
        output: "src/index.ts:10 TS2322",
        durationMs: 400
      });

      const stats = await readStatsFile(env);
      expect(stats.totals.calls).toBe(2);
      expect(stats.totals.durationMs).toBe(600);
      expect(Object.keys(stats.byProject)).toHaveLength(2);
      expect(stats.recent).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("formats single run summary in characters without emojis", () => {
    const summary = formatSingleRunSummary({
      timestamp: "2026-08-25T12:00:00.000Z",
      projectHash: "123456",
      inputChars: 1000,
      outputChars: 40,
      savedChars: 960,
      inputLines: 50,
      outputLines: 2,
      savedLines: 48,
      durationMs: 150,
      charCompressionRatio: 96.0
    });

    expect(summary).toBe("[condense] 1,000 chars -> 40 chars (96.0% chars saved, 150ms)");
    expect(EMOJI_REGEX.test(summary)).toBe(false);
  });

  it("formats global character savings report without emojis", async () => {
    const storage: StatsStorageFile = {
      version: 1,
      totals: {
        calls: 10,
        inputChars: 10000,
        outputChars: 500,
        savedChars: 9500,
        inputLines: 500,
        outputLines: 15,
        savedLines: 485,
        durationMs: 3000
      },
      byProject: {
        proj1: {
          projectPath: "/workspace/my-app",
          calls: 10,
          inputChars: 10000,
          outputChars: 500,
          savedChars: 9500,
          inputLines: 500,
          outputLines: 15,
          savedLines: 485,
          durationMs: 3000
        }
      },
      daily: {},
      recent: [],
      updatedAt: "2026-08-25T12:00:00.000Z"
    };

    const report = formatStatsReport(storage);
    expect(report).toContain("Condense Character Savings Summary (Global)");
    expect(report).toContain("Tokens Saved");
    expect(report).toContain("Total Executions       : 10 calls");
    expect(report).toContain("Chars Saved            : 9,500 chars (95.00%)");
    expect(report).toContain("Lines Saved            : 485 lines (97.00%)");
    expect(report).toContain("Avg Latency            : 300 ms");
    expect(report).not.toContain("By Task");
    expect(report).not.toContain("$");
    expect(EMOJI_REGEX.test(report)).toBe(false);
  });

  it("formats stats report with json output", async () => {
    const storage: StatsStorageFile = {
      version: 1,
      totals: {
        calls: 5,
        inputChars: 5000,
        outputChars: 250,
        savedChars: 4750,
        inputLines: 200,
        outputLines: 10,
        savedLines: 190,
        durationMs: 1500
      },
      byProject: {},
      daily: {},
      recent: [],
      updatedAt: "2026-08-25T12:00:00.000Z"
    };

    const report = formatStatsReport(storage, { json: true });
    const parsed = JSON.parse(report) as { scope: string; summary: { calls: number; charCompressionRatio: number } };
    expect(parsed.scope).toBe("Global");
    expect(parsed.summary.calls).toBe(5);
    expect(parsed.summary.charCompressionRatio).toBe(95);
    expect(report).not.toContain("byTask");
    expect(EMOJI_REGEX.test(report)).toBe(false);
  });

  it("resets global and project character savings stats", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-stats-test-"));
    const env = { CONDENSE_CONFIG_PATH: path.join(dir, "config.json") };

    try {
      await recordCondenseRun(env, {
        cwd: "/project-a",
        question: "test?",
        rawInput: "raw input text",
        output: "out",
        durationMs: 100
      });

      let stats = await readStatsFile(env);
      expect(stats.totals.calls).toBe(1);

      const resetMsg = await resetStats(env);
      expect(resetMsg).toContain("Global character savings stats reset successfully");

      stats = await readStatsFile(env);
      expect(stats.totals.calls).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs stats command via runStatsCommand helper", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-stats-test-"));
    const env = { CONDENSE_CONFIG_PATH: path.join(dir, "config.json") };
    const cwd = "/my/test/repo";

    try {
      await recordCondenseRun(env, {
        cwd,
        question: "Did tests pass?",
        rawInput: "PASS auth.test.ts\nFAIL db.test.ts\n",
        output: "FAIL db.test.ts",
        durationMs: 250
      });

      const globalReport = await runStatsCommand([], { env, cwd });
      expect(globalReport).toContain("Condense Character Savings Summary (Global)");
      expect(globalReport).toContain("Total Executions       : 1 calls");
      expect(globalReport).toContain("Condense Recent Commands");
      expect(globalReport).toContain("Did tests pass?");
      expect(globalReport).toContain("chars)");
      expect(globalReport).not.toContain("By Task");
      expect(EMOJI_REGEX.test(globalReport)).toBe(false);

      const historyReport = await runStatsCommand(["-H"], { env, cwd });
      expect(historyReport).toContain("Condense Recent Commands");
      expect(historyReport).toContain("Did tests pass?");
      expect(EMOJI_REGEX.test(historyReport)).toBe(false);

      const projectReport = await runStatsCommand(["--project", "--history"], { env, cwd });
      expect(projectReport).toContain(`Condense Character Savings Summary (Project: ${cwd})`);
      expect(projectReport).toContain("Condense Recent Commands");
      expect(EMOJI_REGEX.test(projectReport)).toBe(false);

      const jsonReport = await runStatsCommand(["--json"], { env, cwd });
      const parsed = JSON.parse(jsonReport) as { summary: { calls: number }; recent: Array<{ question: string }> };
      expect(parsed.summary.calls).toBe(1);
      expect(parsed.recent[0].question).toBe("Did tests pass?");

      const resetResult = await runStatsCommand(["--reset"], { env, cwd });
      expect(resetResult).toContain("Global character savings stats reset successfully");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws on invalid stats flags", async () => {
    const env = {};
    const cwd = process.cwd();

    expect(runStatsCommand(["--unknown"], { env, cwd })).rejects.toThrow(UsageError);
    expect(runStatsCommand(["--days"], { env, cwd })).rejects.toThrow(UsageError);
    expect(runStatsCommand(["--days", "-5"], { env, cwd })).rejects.toThrow(UsageError);
  });

  it("invokes onBatchStat and writes single-run stats to stderr when showStats is enabled", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-stats-test-"));
    const prevEnv = process.env.CONDENSE_CONFIG_PATH;
    process.env.CONDENSE_CONFIG_PATH = path.join(dir, "config.json");

    try {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      let callbackFired = false;

      const session = new CondenseSession({
        summarizer: {
          summarizeBatch: async () => "PASS\n",
          summarizeWatch: async () => ""
        },
        runtimeConfig: {
          question: "Did tests pass?",
          provider: "local",
          localBackend: "auto",
          localConcurrency: 5,
          localHost: "127.0.0.1",
          localPort: 8009,
          model: "condense-local",
          host: "http://127.0.0.1:8009/v1",
          apiKey: "",
          timeoutMs: 1000,
          datasetEnabled: false,
          showStats: true
        },
        stdout: {
          write: (chunk: string | Uint8Array) => {
            stdoutChunks.push(String(chunk));
            return true;
          }
        },
        stderr: {
          write: (chunk: string | Uint8Array) => {
            stderrChunks.push(String(chunk));
            return true;
          }
        },
        isTTY: false,
        onBatchStat: (stat) => {
          callbackFired = true;
          expect(stat.savedChars).toBeGreaterThan(0);
        }
      });

      session.push(Buffer.from("PASS test/a.test.ts\nPASS test/b.test.ts\n"));
      await session.end();

      expect(callbackFired).toBe(true);
      expect(stdoutChunks.join("")).toContain("PASS");
      const stderrOutput = stderrChunks.join("");
      expect(stderrOutput).toContain("[condense]");
      expect(stderrOutput).toContain("chars ->");
      expect(stderrOutput).toContain("% chars saved");
      expect(EMOJI_REGEX.test(stderrOutput)).toBe(false);
    } finally {
      process.env.CONDENSE_CONFIG_PATH = prevEnv;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

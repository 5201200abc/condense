import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  formatSingleRunSummary,
  formatStatsReport,
  formatTokenMetric,
  readStatsFile,
  recordCondenseRun,
  resetStats,
  resolveStatsPath,
  runStatsCommand,
  writeStatsFile,
  type StatsStorageFile
} from "../src/stats";
import { appendObserveRecord, buildObserveRecord } from "../src/observe";
import { recordRecallSnapshot, resolveRecallDbPath } from "../src/recall";
import { CondenseSession } from "../src/stream-condenser";
import { UsageError } from "../src/config";
import { hashProjectPath } from "../src/dsl-memory";

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

    expect(summary).toBe("[condense] 1,000 chars -> 40 chars (96.0% chars saved, 0.15s)");
    expect(EMOJI_REGEX.test(summary)).toBe(false);
  });

  it("records prompt cache tokens and formats saved seconds", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-stats-cache-"));
    const env = { CONDENSE_CONFIG_PATH: path.join(dir, "config.json") };

    try {
      const run = await recordCondenseRun(env, {
        cwd: "/cache-project",
        question: "Did tests pass?",
        rawInput: "1 passed\n",
        output: "PASS",
        durationMs: 142,
        cacheN: 268,
        promptN: 53,
        promptMs: 58,
        predictedMs: 82,
        cacheSavedMs: 293
      });

      expect(run.cacheN).toBe(268);
      expect(run.promptN).toBe(53);
      expect(run.cacheSavedMs).toBe(293);
      expect(formatSingleRunSummary(run)).toContain("0.14s");
      expect(formatSingleRunSummary(run)).not.toContain("cache ");

      const stats = await readStatsFile(env);
      expect(stats.totals.cacheN).toBe(268);
      expect(stats.totals.promptN).toBe(53);
      expect(stats.totals.cacheSavedMs).toBe(293);
      const report = formatStatsReport(stats);
      expect(report).toContain("Condense Stats · Global");
      expect(report).toContain("Compressed          1 times");
      const jsonReport = formatStatsReport(stats, { json: true });
      const parsed = JSON.parse(jsonReport) as {
        promptCache: { cacheN: number; promptN: number; cacheSavedMs: number };
      };
      expect(parsed.promptCache.cacheN).toBe(268);
      expect(parsed.promptCache.promptN).toBe(53);
      expect(parsed.promptCache.cacheSavedMs).toBe(293);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not present prefix-cache samples as a lifetime 95% hit rate", () => {
    const tiny = (overrides: Partial<StatsStorageFile["recent"][number]>): StatsStorageFile["recent"][number] => ({
      timestamp: "2026-09-10T12:30:48.340Z",
      projectHash: "abc",
      question: "Did tests pass?",
      inputChars: 85,
      outputChars: 23,
      savedChars: 62,
      inputLines: 1,
      outputLines: 1,
      savedLines: 0,
      inputTokens: 20,
      outputTokens: 5,
      savedTokens: 15,
      durationMs: 121,
      charCompressionRatio: 72.9,
      ...overrides
    });
    const storage: StatsStorageFile = {
      version: 1,
      totals: {
        calls: 419,
        inputChars: 6477378,
        outputChars: 65828,
        savedChars: 6411785,
        inputLines: 168418,
        outputLines: 1000,
        savedLines: 167420,
        inputTokens: 2414961,
        outputTokens: 24736,
        savedTokens: 2390442,
        durationMs: 5386333,
        cacheN: 946,
        promptN: 48,
        cacheSavedMs: 3792,
        cacheCalls: 0,
        bypassCalls: 0,
        longLogCalls: 0,
        overflowRiskCalls: 0,
        suspectCalls: 0
      },
      byProject: {},
      daily: {},
      recent: [
        tiny({
          timestamp: "2026-09-10T12:31:35.807Z",
          inputChars: 35,
          outputChars: 4,
          savedChars: 31,
          durationMs: 128,
          cacheN: 268,
          promptN: 40,
          promptMs: 66,
          predictedMs: 10,
          cacheSavedMs: 440
        }),
        tiny({
          cacheN: 339,
          promptN: 4,
          promptMs: 19,
          predictedMs: 52,
          cacheSavedMs: 1647,
          durationMs: 99
        }),
        tiny({
          cacheN: 339,
          promptN: 4,
          promptMs: 20,
          predictedMs: 51,
          cacheSavedMs: 1705
        })
      ],
      updatedAt: "2026-09-10T12:31:35.807Z"
    };

    const report = formatStatsReport(storage);
    expect(report).toContain("Condense Stats · Global");
    expect(report).not.toContain("98.98%");
    expect(report).not.toContain("98.99%");
    expect(report).not.toContain("99.41%");
    expect(report).not.toContain("95.17%");
    expect(formatSingleRunSummary(storage.recent[1]!)).not.toContain("cache ");

    const parsed = JSON.parse(formatStatsReport(storage, { json: true })) as {
      promptCache: { cacheHitRatio: number; cacheSavedS: number; cacheCalls: number };
    };
    expect(parsed.promptCache.cacheCalls).toBe(3);
    expect(parsed.promptCache.cacheSavedS).toBe(0.442);
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
        durationMs: 3000,
        cacheN: 0,
        promptN: 0,
        cacheSavedMs: 0,
        cacheCalls: 0,
        bypassCalls: 0,
        longLogCalls: 0,
        overflowRiskCalls: 0,
        suspectCalls: 0
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
          durationMs: 3000,
          cacheN: 0,
          promptN: 0,
          cacheSavedMs: 0,
          cacheCalls: 0,
        bypassCalls: 0,
        longLogCalls: 0,
        overflowRiskCalls: 0,
        suspectCalls: 0
        }
      },
      daily: {},
      recent: [],
      updatedAt: "2026-08-25T12:00:00.000Z"
    };

    const report = formatStatsReport(storage);
    expect(report).toContain("Condense Stats · Global");
    expect(report).toContain("Compressed          10 times");
    expect(report).toContain("Context");
    expect(report).toContain("Reliability");
    expect(report).not.toContain("Clients");
    expect(report).toContain("Token values are estimated.");
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
        durationMs: 1500,
        cacheN: 0,
        promptN: 0,
        cacheSavedMs: 0,
        cacheCalls: 0,
        bypassCalls: 0,
        longLogCalls: 0,
        overflowRiskCalls: 0,
        suspectCalls: 0
      },
      byProject: {},
      daily: {},
      recent: [],
      updatedAt: "2026-08-25T12:00:00.000Z"
    };

    const report = formatStatsReport(storage, { json: true });
    const parsed = JSON.parse(report) as {
      compressed: number;
      freedEstimatedTokens: number;
    };
    expect(parsed.compressed).toBe(5);
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
      expect(resetMsg).toContain("Global statistics reset successfully");

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
      expect(globalReport).toContain("Condense Stats · Global");
      expect(globalReport).toContain("Compressed          1 times");
      expect(globalReport).toContain("Freed");
      expect(globalReport).toContain("Reliability");
      expect(globalReport).not.toContain("Clients");
      expect(globalReport).toContain("Token values are estimated.");
      expect(EMOJI_REGEX.test(globalReport)).toBe(false);

      const historyReport = await runStatsCommand(["-H"], { env, cwd });
      expect(historyReport).toContain("Recent compressions");
      expect(historyReport).toContain("freed");
      expect(EMOJI_REGEX.test(historyReport)).toBe(false);

      const projectReport = await runStatsCommand(["--project", "-H"], { env, cwd });
      expect(projectReport).toContain("Recent compressions");
      expect(EMOJI_REGEX.test(projectReport)).toBe(false);

      const jsonReport = await runStatsCommand(["--json"], { env, cwd });
      const parsed = JSON.parse(jsonReport) as { compressed: number; freedEstimatedTokens: number };
      expect(parsed.compressed).toBe(1);
      expect(parsed.freedEstimatedTokens).toBeGreaterThan(0);

      const resetResult = await runStatsCommand(["--reset"], { env, cwd });
      expect(resetResult).toContain("Global statistics reset successfully");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prints the same metric rows for stats flag combinations", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-stats-flags-"));
    const env = { CONDENSE_CONFIG_PATH: path.join(dir, "config.json") };
    const cwd = "/my/test/repo";
    const labels = [
      "Context",
      "Compressed",
      "Freed",
      "Avg freed",
      "Largest",
      "Overflow risk",
      "Reliability",
      "Suspects",
      "Mixed PASS/FAIL",
      "Timeout / no result",
      "Terraform unsafe",
      "Dropped error",
      "Token values are estimated."
    ];

    try {
      await recordCondenseRun(env, {
        cwd,
        question: "Did tests pass?",
        rawInput: "PASS auth.test.ts\nFAIL db.test.ts\n",
        output: "FAIL db.test.ts",
        durationMs: 250,
        now: new Date("2026-09-10T12:00:00.000Z")
      });

      const combos = [
        [],
        ["--project"],
        ["--days", "7"],
        ["--project", "--days", "7"]
      ];
      for (const args of combos) {
        const report = await runStatsCommand(args, {
          env,
          cwd,
          now: new Date("2026-09-10T12:00:00.000Z")
        });
        for (const label of labels) {
          expect(report).toContain(label);
        }
        expect(report).not.toContain("Clients");
        if (args.includes("--project")) {
          expect(report).toContain("Condense Stats · Project");
        } else {
          expect(report).toContain("Condense Stats · Global");
        }
      }

      const historyCombos = [
        ["-H"],
        ["--project", "-H"],
        ["--project", "--days", "7", "-H"]
      ];
      for (const args of historyCombos) {
        const report = await runStatsCommand(args, {
          env,
          cwd,
          now: new Date("2026-09-10T12:00:00.000Z")
        });
        expect(report).toContain("Recent compressions");
      }

      const parsed = JSON.parse(
        await runStatsCommand(["--json", "--project", "--days", "7"], {
          env,
          cwd,
          now: new Date("2026-09-10T12:00:00.000Z")
        })
      ) as {
        compressed: number;
        freedEstimatedTokens: number;
        promptCache: { cacheN: number };
      };
      expect(parsed.compressed).toBe(1);
      expect(parsed.freedEstimatedTokens).toBeGreaterThan(0);
      expect(parsed.promptCache.cacheN).toBe(0);
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
      if (prevEnv === undefined) {
        delete process.env.CONDENSE_CONFIG_PATH;
      } else {
        process.env.CONDENSE_CONFIG_PATH = prevEnv;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists per-project recent history across reloads", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-stats-test-"));
    const env = { CONDENSE_CONFIG_PATH: path.join(dir, "config.json") };

    try {
      await recordCondenseRun(env, {
        cwd: "/project-a",
        question: "a1?",
        rawInput: "aaaa",
        output: "a",
        durationMs: 10,
        now: new Date("2026-08-20T12:00:00.000Z")
      });
      await recordCondenseRun(env, {
        cwd: "/project-b",
        question: "b1?",
        rawInput: "bbbb",
        output: "b",
        durationMs: 10,
        now: new Date("2026-08-21T12:00:00.000Z")
      });
      await recordCondenseRun(env, {
        cwd: "/project-a",
        question: "a2?",
        rawInput: "aaaaaa",
        output: "aa",
        durationMs: 10,
        now: new Date("2026-08-22T12:00:00.000Z")
      });

      const stats = await readStatsFile(env);
      const hashA = hashProjectPath("/project-a");
      const hashB = hashProjectPath("/project-b");
      expect(stats.byProject[hashA].recent).toHaveLength(2);
      expect(stats.byProject[hashB].recent).toHaveLength(1);
      expect(stats.byProject[hashA].recent?.map((entry) => entry.question)).toEqual([
        "a2?",
        "a1?"
      ]);

      const projectReport = await runStatsCommand(["--project", "-H"], {
        env,
        cwd: "/project-a"
      });
      expect(projectReport).toContain("Recent compressions");
      const globalHistory = await runStatsCommand(["-H"], { env, cwd: "/project-a" });
      expect(globalHistory).toContain("Recent compressions");

      for (let index = 0; index < 16; index += 1) {
        await recordCondenseRun(env, {
          cwd: "/project-a",
          question: `many-${index}?`,
          rawInput: "x",
          output: "y",
          durationMs: 10
        });
      }
      const cappedProject = await runStatsCommand(["--project", "-H"], {
        env,
        cwd: "/project-a"
      });
      expect(cappedProject).toContain("Recent compressions");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sums daily call counts for --days and keeps project days scoped", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-stats-test-"));
    const env = { CONDENSE_CONFIG_PATH: path.join(dir, "config.json") };
    const now = new Date("2026-08-27T12:00:00.000Z");

    try {
      for (let index = 0; index < 5; index += 1) {
        await recordCondenseRun(env, {
          cwd: "/project-a",
          question: `a-${index}?`,
          rawInput: "input-a",
          output: "a",
          durationMs: 100,
          now: new Date("2026-08-20T12:00:00.000Z")
        });
      }

      for (let index = 0; index < 3; index += 1) {
        await recordCondenseRun(env, {
          cwd: "/project-b",
          question: `b-${index}?`,
          rawInput: "input-b",
          output: "b",
          durationMs: 50,
          now: new Date("2026-08-25T12:00:00.000Z")
        });
      }

      const globalDays = await runStatsCommand(["--days", "7", "--json"], {
        env,
        cwd: "/project-a",
        now
      });
      const globalParsed = JSON.parse(globalDays) as { compressed: number };
      expect(globalParsed.compressed).toBe(8);

      const projectDays = await runStatsCommand(["--project", "--days", "7", "--json"], {
        env,
        cwd: "/project-a",
        now
      });
      const projectParsed = JSON.parse(projectDays) as { compressed: number };
      expect(projectParsed.compressed).toBe(5);

      const hashA = hashProjectPath("/project-a");
      await resetStats(env, { projectHash: hashA });
      const afterReset = await readStatsFile(env, now);
      expect(afterReset.totals.calls).toBe(3);
      expect(afterReset.byProject[hashA]).toBeUndefined();
      expect(afterReset.daily["2026-08-20"]).toBeUndefined();
      expect(afterReset.daily["2026-08-25"].calls).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("bypasses short stdin when skip policy is on", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-stats-bypass-"));
    const env = { CONDENSE_CONFIG_PATH: path.join(dir, "config.json") };

    try {
      let recordedBypass: string | undefined;
      const session = new CondenseSession({
        env,
        cwd: dir,
        applySkipPolicy: true,
        runtimeConfig: {
          question: "Which files are shown?",
          provider: "local",
          localBackend: "auto",
          localConcurrency: 5,
          localHost: "127.0.0.1",
          localPort: 8009,
          model: "condense-local",
          host: "http://127.0.0.1:8009/v1",
          apiKey: "",
          timeoutMs: 1000,
          datasetEnabled: false
        },
        summarizer: {
          summarizeBatch: async () => "should not run",
          summarizeWatch: async () => ""
        },
        stdout: { write: () => true },
        isTTY: false,
        onBatchStat: (stat) => {
          recordedBypass = stat.bypass;
        }
      });
      session.push(Buffer.from("ls\nfile.txt\n"));
      await session.end();
      expect(recordedBypass).toBe("short");
      const report = await runStatsCommand(["--project", "--json"], { env, cwd: dir });
      expect(JSON.parse(report).bypassed).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records watch summaries onto the current project", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-stats-watch-"));
    const env = { CONDENSE_CONFIG_PATH: path.join(dir, "config.json") };
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    try {
      let recorded = 0;
      const session = new CondenseSession({
        env,
        cwd: dir,
        idleMs: 15,
        interactiveGapMs: 5,
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
          datasetEnabled: false
        },
        summarizer: {
          summarizeBatch: async () => "unused",
          summarizeWatch: async () => "failure count changed"
        },
        stdout: { write: () => true },
        isTTY: false,
        onBatchStat: () => {
          recorded += 1;
        }
      });
      session.push(Buffer.from("watch run\nfailed: 0\n"));
      await sleep(25);
      session.push(Buffer.from("watch run\nfailed: 1\n"));
      await sleep(40);
      await session.end();

      expect(recorded).toBe(1);
      const report = await runStatsCommand(["--project"], { env, cwd: dir });
      expect(report).toContain("Compressed          1 times");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records stats when distillation falls back to raw output", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-stats-fallback-"));
    const env = { CONDENSE_CONFIG_PATH: path.join(dir, "config.json") };
    const input = "PASS test/a.test.ts\n";

    try {
      const session = new CondenseSession({
        env,
        cwd: dir,
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
          datasetEnabled: false
        },
        summarizer: {
          summarizeBatch: async () => input,
          summarizeWatch: async () => ""
        },
        stdout: { write: () => true },
        isTTY: false
      });
      session.push(Buffer.from(input));
      await session.end();

      const report = await runStatsCommand(["--project"], { env, cwd: dir });
      expect(report).toContain("Compressed          1 times");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("attributes subdirectory runs to the git root for --project", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-stats-git-"));
    const env = { CONDENSE_CONFIG_PATH: path.join(dir, "config.json") };
    const nested = path.join(dir, "src");
    await mkdir(nested);
    const git = spawnSync("git", ["-C", dir, "init"], { encoding: "utf8" });
    expect(git.status).toBe(0);

    try {
      await recordCondenseRun(env, {
        cwd: nested,
        question: "nested?",
        rawInput: "abcdef",
        output: "a",
        durationMs: 10
      });
      const fromRoot = await runStatsCommand(["--project"], { env, cwd: dir });
      expect(fromRoot).toContain("Compressed          1 times");
      const fromNested = await runStatsCommand(["--project"], { env, cwd: nested });
      expect(fromNested).toContain("Compressed          1 times");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("says this project has no runs instead of a global empty state", () => {
    const storage: StatsStorageFile = {
      version: 1,
      totals: {
        calls: 10,
        inputChars: 1000,
        outputChars: 10,
        savedChars: 990,
        inputLines: 10,
        outputLines: 1,
        savedLines: 9,
        durationMs: 100,
        cacheN: 0,
        promptN: 0,
        cacheSavedMs: 0,
        cacheCalls: 0,
        bypassCalls: 0,
        longLogCalls: 0,
        overflowRiskCalls: 0,
        suspectCalls: 0
      },
      byProject: {},
      daily: {},
      recent: [],
      updatedAt: "2026-09-10T12:00:00.000Z"
    };
    const report = formatStatsReport(storage, {
      projectHash: "deadbeefdeadbeef",
      projectPath: "/path/to/project/transit"
    });
    expect(report).toContain("Condense Stats · Project");
    expect(report).toContain("Compressed          0 times");
  });

  it("supports -h and --help for dedicated stats usage", async () => {
    const env = {};
    const cwd = process.cwd();

    const shortHelp = await runStatsCommand(["-h"], { env, cwd });
    expect(shortHelp).toContain("Usage:\n  condense stats [options]");
    expect(shortHelp).toContain("--client <name>");
    expect(shortHelp).toContain("-H, --history");

    const longHelp = await runStatsCommand(["--help"], { env, cwd });
    expect(longHelp).toBe(shortHelp);
  });

  it("formats token metrics according to the specification", () => {
    expect(formatTokenMetric(2_410_000)).toBe("2.41M");
    expect(formatTokenMetric(57_000)).toBe("57K");
    expect(formatTokenMetric(312_000)).toBe("312K");
    expect(formatTokenMetric(8_800)).toBe("8.8K");
    expect(formatTokenMetric(11_000)).toBe("11K");
    expect(formatTokenMetric(9_400)).toBe("9.4K");
    expect(formatTokenMetric(0)).toBe("0");
    expect(formatTokenMetric(-10)).toBe("0");
  });

  it("renders the exact definitive stats overview with context, reliability, clients, and suspects", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-stats-definitive-"));
    const env = {
      CONDENSE_CONFIG_PATH: path.join(dir, "config.json"),
      CONDENSE_OBSERVE_PATH: path.join(dir, "observe.jsonl")
    };
    const cwd = "/my/test/repo";

    try {
      // 1. A suspect with mixed_pass_fail from Codex
      const r1 = buildObserveRecord({
        requestId: "f0bbb37e12345678",
        question: "Did tests pass?",
        rawInput: "FAIL auth.test.ts\nPASS db.test.ts\n",
        output: "PASS db.test.ts",
        inputLines: 2,
        now: new Date("2026-09-11T10:00:00.000Z"),
        client: "Codex",
        model: "v2",
        latencyMs: 120,
        projectPath: cwd
      });
      await appendObserveRecord(env, r1);

      // 2. A suspect with dropped error from Claude Code
      const r2 = buildObserveRecord({
        requestId: "a83f21c987654321",
        question: "Did tests pass?",
        rawInput: "FAIL src/user.test.ts\nFAIL src/order.test.ts\n",
        output: "FAIL src/user.test.ts",
        inputLines: 2,
        now: new Date("2026-09-10T09:00:00.000Z"),
        client: "Claude Code",
        model: "v2",
        latencyMs: 150,
        projectPath: cwd
      });
      await appendObserveRecord(env, r2);

      // 3. Normal run from Codex
      const r3 = buildObserveRecord({
        requestId: "1122334455667788",
        question: "What failed?",
        rawInput: "FAIL auth.test.ts\n",
        output: "FAIL auth.test.ts",
        inputLines: 1,
        now: new Date("2026-09-11T11:00:00.000Z"),
        client: "Codex",
        model: "v2",
        latencyMs: 80,
        projectPath: cwd
      });
      await appendObserveRecord(env, r3);

      const report = await runStatsCommand([], { env, cwd });
      expect(report).toContain("Condense Stats · Global");
      expect(report).toContain("Context");
      expect(report).toContain("Compressed          3 times");
      expect(report).toContain("Reliability");
      expect(report).toContain("Suspects                2");
      expect(report).toContain("Mixed PASS/FAIL");
      expect(report).toContain("Dropped error");
      expect(report).toContain("Clients");
      expect(report).toContain("Codex");
      expect(report).toContain("Claude Code");
      expect(report).toContain("Recent suspects");
      expect(report).toMatch(/\d\d-\d\d \d\d:\d\d  f0bbb37e  Codex {8}Mixed PASS\/FAIL/);
      expect(report).toMatch(/\d\d-\d\d \d\d:\d\d  a83f21c9  Claude Code  Dropped error/);
      expect(report).toContain("Token values are estimated.");
      expect(report).not.toContain("Window impact");

      // History mode
      const history = await runStatsCommand(["-H"], { env, cwd });
      expect(history).toContain("Recent compressions");
      expect(history).toContain("Codex");
      expect(history).toContain("Claude Code");
      expect(history).toContain("SUSPECT  f0bbb37e");
      expect(history).toContain("SUSPECT  a83f21c9");
      expect(history).toContain("OK");

      // Client filter
      const codexOnly = await runStatsCommand(["--client", "codex"], { env, cwd });
      expect(codexOnly).toContain("Compressed          2 times");
      expect(codexOnly).toContain("Codex");
      expect(codexOnly).not.toContain("Claude Code");

      const claudeOnly = await runStatsCommand(["--client", "claude-code"], { env, cwd });
      expect(claudeOnly).toContain("Compressed          1 times");
      expect(claudeOnly).toContain("Claude Code");
      expect(claudeOnly).not.toContain("Codex");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("renders Window impact when explicit context window is present", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-stats-window-"));
    const env = {
      CONDENSE_CONFIG_PATH: path.join(dir, "config.json"),
      CONDENSE_OBSERVE_PATH: path.join(dir, "observe.jsonl")
    };
    const cwd = "/my/test/repo";

    try {
      const r1 = buildObserveRecord({
        requestId: "req1",
        question: "summary",
        rawInput: "a ".repeat(500),
        output: "short output",
        inputLines: 5,
        client: "Codex",
        contextWindowTokens: 258_000,
        projectPath: cwd
      });
      await appendObserveRecord(env, r1);

      const r2 = buildObserveRecord({
        requestId: "req2",
        question: "summary",
        rawInput: "b ".repeat(250),
        output: "short output",
        inputLines: 3,
        client: "Claude Code",
        contextWindowTokens: 128_000,
        projectPath: cwd
      });
      await appendObserveRecord(env, r2);

      const r3 = buildObserveRecord({
        requestId: "req3",
        question: "summary",
        rawInput: "c ".repeat(50),
        output: "short",
        inputLines: 2,
        client: "Unknown",
        projectPath: cwd
      });
      await appendObserveRecord(env, r3);

      const report = await runStatsCommand([], { env, cwd });
      expect(report).toContain("Window impact");
      expect(report).toContain("258K");
      expect(report).toContain("128K");
      expect(report).toContain("Unknown");
      expect(report).toContain("Avg recovered");

      const jsonReport = await runStatsCommand(["--json"], { env, cwd });
      const parsed = JSON.parse(jsonReport) as { contextWindows: Record<string, { runs: number }> };
      expect(parsed.contextWindows["258K"].runs).toBe(1);
      expect(parsed.contextWindows["128K"].runs).toBe(1);
      expect(parsed.contextWindows["Unknown"].runs).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stats --reset clears stats and observe records while preserving recall.db", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-stats-reset-"));
    const env = {
      CONDENSE_CONFIG_PATH: path.join(dir, "config.json"),
      CONDENSE_OBSERVE_PATH: path.join(dir, "observe.jsonl"),
      CONDENSE_RECALL_PATH: path.join(dir, "recall.db")
    };
    const cwd = "/my/test/repo";

    try {
      await recordCondenseRun(env, {
        cwd,
        question: "run?",
        rawInput: "raw",
        output: "out",
        durationMs: 50
      });

      const observeRecord = buildObserveRecord({
        requestId: "test_reset_id",
        question: "q",
        rawInput: "input",
        output: "out",
        inputLines: 1,
        client: "Codex",
        projectPath: cwd
      });
      await appendObserveRecord(env, observeRecord);

      await recordRecallSnapshot(env, {
        requestId: "test_reset_id",
        projectPath: cwd,
        question: "q",
        rawInput: "input",
        output: "out",
        rawChars: 5,
        rawBytes: 5,
        outputChars: 3,
        rawEstimatedTokens: 2,
        outputEstimatedTokens: 1
      });

      const recallPath = resolveRecallDbPath(env);
      const recallBefore = await stat(recallPath);
      expect(recallBefore.size).toBeGreaterThan(0);

      const resetMsg = await runStatsCommand(["--reset"], { env, cwd });
      expect(resetMsg).toContain("Global statistics reset successfully");

      // Verify stats.json is gone/reset
      const statsAfter = await readStatsFile(env);
      expect(statsAfter.totals.calls).toBe(0);

      // Verify observe.jsonl is cleared
      const observeRecordsAfter = await (await import("../src/observe")).readObserveRecords(env);
      expect(observeRecordsAfter).toHaveLength(0);

      // Verify recall.db is still intact!
      const recallAfter = await stat(recallPath);
      expect(recallAfter.size).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("excludes legacy records from active metrics and conditionally renders clients", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-stats-legacy-"));
    const env = {
      CONDENSE_CONFIG_PATH: path.join(dir, "config.json"),
      CONDENSE_OBSERVE_PATH: path.join(dir, "observe.jsonl")
    };
    const cwd = "/my/legacy/repo";

    try {
      // 1. Legacy record 1: missing requestId (becomes "00000000"), rawEstimatedTokens 0, suspect
      await appendObserveRecord(env, {
        requestId: "00000000",
        timestamp: "2026-09-10T10:00:00.000Z",
        kinds: ["suspect"],
        suspectReasons: ["mixed_pass_fail"],
        question: "Did tests pass?",
        inputChars: 500,
        inputLines: 20,
        outputChars: 50,
        rawEstimatedTokens: 0,
        outputEstimatedTokens: 0,
        output: "FAIL",
        client: "Unknown",
        model: "v2",
        latencyMs: 100,
        projectPath: cwd
      });

      // 2. Legacy record 2: valid-looking id but rawEstimatedTokens <= 0
      await appendObserveRecord(env, {
        requestId: "legacyno01",
        timestamp: "2026-09-10T11:00:00.000Z",
        kinds: [],
        suspectReasons: [],
        question: "What happened?",
        inputChars: 400,
        inputLines: 15,
        outputChars: 40,
        rawEstimatedTokens: 0,
        outputEstimatedTokens: 0,
        output: "OK",
        client: "Unknown",
        model: "v2",
        latencyMs: 80,
        projectPath: cwd
      });

      // 3. Valid active record: valid requestId, valid tokens, suspect
      const validRecord1 = buildObserveRecord({
        requestId: "valid00112233445",
        question: "Did tests pass?",
        rawInput: "FAIL auth.test.ts\nPASS db.test.ts\n",
        output: "PASS db.test.ts",
        inputLines: 2,
        now: new Date("2026-09-11T10:00:00.000Z"),
        client: "Unknown",
        model: "v2",
        latencyMs: 120,
        projectPath: cwd
      });
      await appendObserveRecord(env, validRecord1);

      // Only 1 active record, 2 legacy records. All clients are Unknown.
      const reportOnlyUnknown = await runStatsCommand([], { env, cwd });
      expect(reportOnlyUnknown).toContain("Compressed          1 times");
      expect(reportOnlyUnknown).toContain("Suspects                1");
      expect(reportOnlyUnknown).not.toContain("Clients");
      expect(reportOnlyUnknown).not.toContain("00000000");
      expect(reportOnlyUnknown).toContain("valid001");
      expect(reportOnlyUnknown).not.toContain("tokens\n");

      // History only shows the 1 valid record
      const historyReport = await runStatsCommand(["-H"], { env, cwd });
      expect(historyReport).toContain("valid001");
      expect(historyReport).not.toContain("00000000");
      expect(historyReport).not.toContain("legacyno");

      // JSON payload separates active counts from legacy volume
      const jsonReport = await runStatsCommand(["--json"], { env, cwd });
      const parsed = JSON.parse(jsonReport) as {
        compressed: number;
        suspects: number;
        volume: { inputChars: number };
        legacy: { runs: number };
      };
      expect(parsed.compressed).toBe(1);
      expect(parsed.suspects).toBe(1);
      expect(parsed.volume.inputChars).toBe(500 + 400 + validRecord1.inputChars);
      expect(parsed.legacy.runs).toBe(2);

      // 4. Now add an active record with known client "Codex"
      const codexRecord = buildObserveRecord({
        requestId: "codex00112233445",
        question: "What failed?",
        rawInput: "FAIL auth.test.ts\n",
        output: "FAIL auth.test.ts",
        inputLines: 1,
        now: new Date("2026-09-11T12:00:00.000Z"),
        client: "Codex",
        model: "v2",
        latencyMs: 90,
        projectPath: cwd
      });
      await appendObserveRecord(env, codexRecord);

      // Now Clients section MUST appear because known client Codex exists
      const reportWithCodex = await runStatsCommand([], { env, cwd });
      expect(reportWithCodex).toContain("Compressed          2 times");
      expect(reportWithCodex).toContain("Clients");
      expect(reportWithCodex).toContain("Codex");
      expect(reportWithCodex).toContain("Unknown");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
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
      expect(report).toContain("Prompt cache           : 268 / 321 tok (1/1 calls)");
      expect(report).toContain("Cache time saved       : 0.29s");
      expect(report).toContain("Avg Latency            : 0.14s");
      expect(report).not.toContain("->");
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
    expect(report).toContain("Chars Saved            : 6,411,785 chars (volume 99%)");
    expect(report).toContain("Prompt cache           : 946 / 994 tok (3/419 calls)");
    expect(report).toContain("Cache time saved       : 0.44s");
    expect(report).not.toContain("->");
    expect(report).not.toContain("98.98%");
    expect(report).not.toContain("98.99%");
    expect(report).not.toContain("99.41%");
    expect(report).not.toContain("95.17%");
    expect(report).not.toContain("3.79s");
    expect(report).not.toContain("Tokens Saved");
    expect(formatSingleRunSummary(storage.recent[1]!)).not.toContain("cache ");

    const parsed = JSON.parse(formatStatsReport(storage, { json: true })) as {
      summary: { cacheHitRatio: number; cacheSavedS: number; cacheCalls: number };
    };
    expect(parsed.summary.cacheCalls).toBe(3);
    expect(parsed.summary.cacheSavedS).toBe(0.442);
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
    expect(report).toContain("Condense Character Savings Summary (Global)");
    expect(report).toContain("Chars Saved            : 9,500 chars (volume 95%)");
    expect(report).toContain("Frontier input avoided");
    expect(report).toContain("Total Executions       : 10 calls");
    expect(report).toContain("Avg Latency            : 0.30s");
    expect(report).not.toContain("->");
    expect(report).not.toContain("Tokens Saved");
    expect(report).not.toContain("97.00%");
    expect(report).toContain("Prompt cache           : 0 / 0 tok (0/10 calls)");
    expect(report).toContain("Cache time saved       : 0.00s");
    expect(report).toContain("Bypassed               : 0 calls");
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
      kind: string;
      scope: string;
      summary: { calls: number; charCompressionRatio: number };
    };
    expect(parsed.kind).toBe("global");
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

  it("prints the same metric rows for stats flag combinations", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-stats-flags-"));
    const env = { CONDENSE_CONFIG_PATH: path.join(dir, "config.json") };
    const cwd = "/my/test/repo";
    const labels = [
      "Chars Saved",
      "Frontier input avoided",
      "Long logs",
      "Overflow-risk logs",
      "Bypassed",
      "Suspect summaries",
      "Total Executions",
      "Raw Input Processed",
      "Condensed Output",
      "Avg Latency",
      "Prompt cache",
      "Cache time saved"
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
        ["-H"],
        ["--project"],
        ["--project", "-H"],
        ["--days", "7"],
        ["--project", "--days", "7"],
        ["--project", "--days", "7", "-H"]
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
        if (args.includes("--project")) {
          expect(report).toContain("Project: /my/test/repo");
          expect(report).toContain("Condense Recent Commands (this project)");
          expect(report).not.toContain("Condense Recent Commands (global)");
        } else {
          expect(report).toContain("Summary (Global");
          expect(report).toContain("Condense Recent Commands (global)");
          expect(report).not.toContain("Summary (Project:");
          expect(report).not.toContain("Condense Recent Commands (this project)");
        }
      }

      const parsed = JSON.parse(
        await runStatsCommand(["--json", "--project", "--days", "7"], {
          env,
          cwd,
          now: new Date("2026-09-10T12:00:00.000Z")
        })
      ) as {
        kind: string;
        projectPath: string;
        byProject?: unknown;
        summary: {
          cacheN: number;
          cacheSavedS: number;
          frontierInputAvoided: number;
        };
      };
      expect(parsed.kind).toBe("project");
      expect(parsed.projectPath).toBe(cwd);
      expect(parsed.byProject).toBeUndefined();
      expect(parsed.summary.frontierInputAvoided).toBeGreaterThan(0);
      expect(parsed.summary.cacheN).toBe(0);
      expect(parsed.summary.cacheSavedS).toBe(0);
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

      const projectReport = await runStatsCommand(["--project", "--history"], {
        env,
        cwd: "/project-a"
      });
      expect(projectReport).toContain("a2?");
      expect(projectReport).toContain("a1?");
      expect(projectReport).not.toContain("b1?");
      expect(projectReport).toContain("Condense Recent Commands (this project)");
      const globalHistory = await runStatsCommand(["-H"], { env, cwd: "/project-a" });
      expect(globalHistory).toContain("Condense Recent Commands (global)");
      expect(globalHistory).toContain("b1?");
      const projectJson = JSON.parse(
        await runStatsCommand(["--json", "--project"], { env, cwd: "/project-a" })
      ) as { kind: string; byProject?: unknown; recent: Array<{ question: string }> };
      expect(projectJson.kind).toBe("project");
      expect(projectJson.byProject).toBeUndefined();
      expect(projectJson.recent.map((entry) => entry.question)).toEqual(["a2?", "a1?"]);

      for (let index = 0; index < 16; index += 1) {
        await recordCondenseRun(env, {
          cwd: "/project-a",
          question: `many-${index}?`,
          rawInput: "x",
          output: "y",
          durationMs: 10
        });
      }
      const cappedProject = await runStatsCommand(["--project"], {
        env,
        cwd: "/project-a"
      });
      const recentLines = cappedProject
        .split("\n")
        .filter((line) => line.includes("many-") || line.includes("a1?") || line.includes("a2?"));
      expect(recentLines).toHaveLength(15);
      expect(cappedProject).not.toContain("b1?");
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
      const globalParsed = JSON.parse(globalDays) as { summary: { calls: number } };
      expect(globalParsed.summary.calls).toBe(8);

      const projectDays = await runStatsCommand(["--project", "--days", "7", "--json"], {
        env,
        cwd: "/project-a",
        now
      });
      const projectParsed = JSON.parse(projectDays) as { summary: { calls: number } };
      expect(projectParsed.summary.calls).toBe(5);

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
      const report = await runStatsCommand(["--project"], { env, cwd: dir });
      expect(report).toContain("Bypassed");
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
      expect(report).toContain("Total Executions       : 1 calls");
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
      expect(report).toContain("Total Executions       : 1 calls");
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
      expect(fromRoot).toContain("Total Executions       : 1 calls");
      expect(fromRoot).toContain(`Project: ${await realpath(dir)}`);
      const fromNested = await runStatsCommand(["--project"], { env, cwd: nested });
      expect(fromNested).toContain("Total Executions       : 1 calls");
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
    expect(report).toContain("No condense runs recorded for this project.");
    expect(report).not.toContain("No condense runs recorded yet.");
  });
});

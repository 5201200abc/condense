import { describe, expect, it } from "bun:test";
import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  getLatestRecallRecord,
  getRecallRecord,
  lookupRecallRecord,
  pruneRecallSnapshots,
  recordRecallSnapshot,
  runRecallCommand,
  searchAround,
  searchGrep
} from "../src/recall";
import { CondenseSession } from "../src/stream-condenser";

describe("recall", () => {
  it("records snapshot and retrieves by exact id and prefix, enforcing 0600 permissions", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-recall-"));
    const env = { CONDENSE_RECALL_PATH: path.join(dir, "recall.db") };

    try {
      const raw = "line1\nline2\nline3\nerror TS1234: bad type\nline5\n";
      await recordRecallSnapshot(env, {
        requestId: "abcdef1234567890",
        projectPath: "/test/project",
        question: "test question",
        rawInput: raw,
        output: "FAIL TS1234",
        rawChars: raw.length,
        outputChars: 11,
        rawEstimatedTokens: 15,
        outputEstimatedTokens: 4
      });

      // Verify file permissions 0600
      const stat = statSync(env.CONDENSE_RECALL_PATH);
      expect(stat.mode & 0o777).toBe(0o600);

      const exact = getRecallRecord(env, "abcdef1234567890");
      expect(exact).not.toBeNull();
      expect(exact?.request_id).toBe("abcdef1234567890");
      expect(exact?.project_path).toBe("/test/project");
      expect(exact?.question).toBe("test question");
      expect(exact?.raw_input).toContain("error TS1234");
      expect(exact?.output).toBe("FAIL TS1234");
      expect(exact?.raw_chars).toBe(raw.length);
      expect(exact?.raw_bytes).toBe(Buffer.byteLength(raw, "utf8"));
      expect(exact?.raw_estimated_tokens).toBe(15);
      expect(exact?.output_estimated_tokens).toBe(4);

      // Prefix match
      const prefix = getRecallRecord(env, "abcdef");
      expect(prefix).not.toBeNull();
      expect(prefix?.request_id).toBe("abcdef1234567890");

      // Non-existent match
      const nonExistent = getRecallRecord(env, "zzz999");
      expect(nonExistent).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects and rejects ambiguous prefix matches", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-recall-ambiguous-"));
    const env = { CONDENSE_RECALL_PATH: path.join(dir, "recall.db") };

    try {
      await recordRecallSnapshot(env, {
        requestId: "aabbcc1111111111",
        timestamp: "2026-09-11T10:00:00.000Z",
        projectPath: "/repo",
        question: "q1",
        rawInput: "log 1\n",
        output: "out 1",
        rawChars: 6,
        outputChars: 5,
        rawEstimatedTokens: 2,
        outputEstimatedTokens: 2
      });

      await recordRecallSnapshot(env, {
        requestId: "aabbcc2222222222",
        timestamp: "2026-09-11T10:05:00.000Z",
        projectPath: "/repo",
        question: "q2",
        rawInput: "log 2\n",
        output: "out 2",
        rawChars: 6,
        outputChars: 5,
        rawEstimatedTokens: 2,
        outputEstimatedTokens: 2
      });

      const lookup = lookupRecallRecord(env, "aabbcc");
      expect(lookup.kind).toBe("ambiguous");
      if (lookup.kind === "ambiguous") {
        expect(lookup.matches).toHaveLength(2);
        expect(lookup.matches).toContain("aabbcc1111111111");
        expect(lookup.matches).toContain("aabbcc2222222222");
      }

      expect(getRecallRecord(env, "aabbcc")).toBeNull();

      // CLI returns error and prompts for longer ID
      let stderrBuf = "";
      const code = await runRecallCommand(["aabbcc"], {
        env,
        stdout: { write: () => {} },
        stderr: { write: (s: string) => { stderrBuf += s; } }
      });
      expect(code).toBe(1);
      expect(stderrBuf).toContain('prefix "aabbcc" is ambiguous');
      expect(stderrBuf).toContain("Please specify a longer ID");

      // Exact full ID still works without ambiguity
      expect(getRecallRecord(env, "aabbcc1111111111")?.request_id).toBe("aabbcc1111111111");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prunes oldest snapshots when max records or max bytes is exceeded", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-recall-prune-"));
    const env = {
      CONDENSE_RECALL_PATH: path.join(dir, "recall.db"),
      CONDENSE_RECALL_MAX_RECORDS: "3",
      CONDENSE_RECALL_MAX_BYTES: "500"
    };

    try {
      // Insert 4 records, maxRecords is 3
      for (let i = 1; i <= 4; i += 1) {
        await recordRecallSnapshot(env, {
          requestId: `req_${i}`,
          timestamp: `2026-09-11T10:0${i}:00.000Z`,
          projectPath: "/repo",
          question: `q${i}`,
          rawInput: `small log ${i}\n`,
          output: `out ${i}`,
          rawChars: 12,
          outputChars: 5,
          rawEstimatedTokens: 3,
          outputEstimatedTokens: 2
        });
      }

      // req_1 should be pruned (oldest)
      expect(getRecallRecord(env, "req_1")).toBeNull();
      expect(getRecallRecord(env, "req_2")).not.toBeNull();
      expect(getRecallRecord(env, "req_3")).not.toBeNull();
      expect(getRecallRecord(env, "req_4")).not.toBeNull();

      // Now insert a large record that exceeds 500 chars
      const bigLog = "x".repeat(450);
      await recordRecallSnapshot(env, {
        requestId: "req_big",
        timestamp: "2026-09-11T10:10:00.000Z",
        projectPath: "/repo",
        question: "big q",
        rawInput: bigLog,
        output: "out",
        rawChars: bigLog.length,
        outputChars: 3,
        rawEstimatedTokens: 100,
        outputEstimatedTokens: 1
      });

      // Older records req_2 and req_3 should be pruned to keep total <= 500
      expect(getRecallRecord(env, "req_big")).not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prunes by actual UTF-8 byte length, not character length", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-recall-bytes-"));
    const env = {
      CONDENSE_RECALL_PATH: path.join(dir, "recall.db"),
      CONDENSE_RECALL_MAX_RECORDS: "100",
      CONDENSE_RECALL_MAX_BYTES: "250"
    };

    try {
      // 1. Insert small record of 16 ASCII bytes
      await recordRecallSnapshot(env, {
        requestId: "ascii_1",
        timestamp: "2026-09-11T10:00:00.000Z",
        projectPath: "/repo",
        question: "q",
        rawInput: "small ascii log\n",
        output: "out",
        rawChars: 16,
        outputChars: 3,
        rawEstimatedTokens: 4,
        outputEstimatedTokens: 1
      });
      expect(getRecallRecord(env, "ascii_1")).not.toBeNull();

      // 2. Insert Chinese text: 102 characters, but 306 UTF-8 bytes (> 250 byte limit)
      const chineseText = "测试日志内容".repeat(17); // 102 chars * 3 bytes = 306 bytes
      expect(chineseText.length).toBeLessThan(250); // char length is 102 < 250
      expect(Buffer.byteLength(chineseText, "utf8")).toBeGreaterThan(250); // byte length is 306 > 250

      await recordRecallSnapshot(env, {
        requestId: "chinese_1",
        timestamp: "2026-09-11T10:05:00.000Z",
        projectPath: "/repo",
        question: "q",
        rawInput: chineseText,
        output: "out",
        rawChars: chineseText.length,
        outputChars: 3,
        rawEstimatedTokens: 50,
        outputEstimatedTokens: 1
      });

      // Because 306 bytes > 250, ascii_1 should be pruned even though total chars (16 + 102 = 118) was < 250
      expect(getRecallRecord(env, "ascii_1")).toBeNull();
      expect(getRecallRecord(env, "chinese_1")).not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("searches with grep correctly", () => {
    const lines = [
      "2026-09-11 10:00:00 INFO starting",
      "2026-09-11 10:00:01 ERROR database connection failed",
      "2026-09-11 10:00:02 INFO retry in 5s",
      "2026-09-11 10:00:07 ERROR timeout"
    ];

    const results = searchGrep(lines, "error");
    expect(results).toHaveLength(2);
    expect(results[0]).toContain("database connection failed");
    expect(results[1]).toContain("timeout");

    // Special regex characters handled safely when invalid
    const unclosedResults = searchGrep(["prefix [error suffix", "no match"], "[error");
    expect(unclosedResults).toHaveLength(1);

    // Escaped regex
    const escapedResults = searchGrep(["prefix [error] suffix", "no match"], "\\[error\\]");
    expect(escapedResults).toHaveLength(1);
  });

  it("searches around matching lines with context merging", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    lines[10] = "CRITICAL FAIL 1";
    lines[12] = "CRITICAL FAIL 2";

    const around = searchAround(lines, "CRITICAL", 2);
    // Lines 8 to 14 should be included and merged
    expect(around).toContain("line 8");
    expect(around).toContain("CRITICAL FAIL 1");
    expect(around).toContain("CRITICAL FAIL 2");
    expect(around).toContain("line 14");
    expect(around).not.toContain("line 7");
    expect(around).not.toContain("line 15");
  });

  it("runs recall command via runRecallCommand", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-recall-cmd-"));
    const env = { CONDENSE_RECALL_PATH: path.join(dir, "recall.db") };

    try {
      const rawText = [
        "step 1: init",
        "step 2: build",
        "step 3: test",
        "FAILED: test_auth",
        "step 4: cleanup"
      ].join("\n");

      await recordRecallSnapshot(env, {
        requestId: "rec_9988776655",
        projectPath: "/repo",
        question: "did it pass?",
        rawInput: rawText,
        output: "FAILED: test_auth",
        rawChars: rawText.length,
        outputChars: 17,
        rawEstimatedTokens: 20,
        outputEstimatedTokens: 5
      });

      let stdoutBuf = "";
      let stderrBuf = "";
      const stdout = { write: (s: string) => { stdoutBuf += s; } };
      const stderr = { write: (s: string) => { stderrBuf += s; } };

      // 1. Full recall
      stdoutBuf = "";
      stderrBuf = "";
      let code = await runRecallCommand(["rec_9988"], { env, stdout, stderr });
      expect(code).toBe(0);
      expect(stdoutBuf).toContain("FAILED: test_auth");
      expect(stdoutBuf).toContain("step 1: init");

      // 2. Grep
      stdoutBuf = "";
      stderrBuf = "";
      code = await runRecallCommand(["rec_9988", "--grep", "FAILED"], { env, stdout, stderr });
      expect(code).toBe(0);
      expect(stdoutBuf.trim()).toBe("FAILED: test_auth");

      // 3. Around
      stdoutBuf = "";
      stderrBuf = "";
      code = await runRecallCommand(["rec_9988", "--around", "FAILED", "-C", "1"], { env, stdout, stderr });
      expect(code).toBe(0);
      expect(stdoutBuf).toContain("step 3: test\nFAILED: test_auth\nstep 4: cleanup");

      // 4. Missing ID
      stdoutBuf = "";
      stderrBuf = "";
      code = await runRecallCommand([], { env, stdout, stderr });
      expect(code).toBe(1);
      expect(stderrBuf).toContain("Usage:");

      // 5. Not found
      stdoutBuf = "";
      stderrBuf = "";
      code = await runRecallCommand(["nonexistent_id"], { env, stdout, stderr });
      expect(code).toBe(1);
      expect(stderrBuf).toContain("record not found");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("integrates with StreamCondenser: writes recall on successful compression and bypass ignores", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-sc-recall-"));
    const env = {
      CONDENSE_RECALL_PATH: path.join(dir, "recall.db"),
      CONDENSE_OBSERVE_PATH: path.join(dir, "observe.jsonl")
    };

    try {
      // 1. Long log that gets compressed
      const passes = Array.from({ length: 120 }, (_, i) => `PASS test/unit_${i}.test.ts`);
      const longInput = `${passes.join("\n")}\nFAIL test/integration.test.ts\n`;

      let stdoutOutput = "";
      const session = new CondenseSession({
        cwd: dir,
        summarizer: {
          summarizeBatch: async () => ({
            content: "FAIL test/integration.test.ts",
            timings: { promptN: 50, completionN: 10 }
          }),
          summarizeWatch: async () => "watch"
        },
        runtimeConfig: {
          question: "what failed?",
          showStats: false,
          model: "condense-v2",
          host: "http://127.0.0.1:11434/v1",
          timeoutMs: 5000,
          provider: "local",
          localBackend: "llamacpp",
          localConcurrency: 5,
          datasetEnabled: false,
          autoLearn: false,
          autoPromoteScopes: []
        },
        env,
        stdout: { write: (s: any) => { stdoutOutput += s.toString(); } } as any,
        stderr: { write: () => {} } as any
      });

      session.push(Buffer.from(longInput));
      await session.end();

      expect(stdoutOutput.trim()).toBe("FAIL test/integration.test.ts");

      // Verify recall record was created
      const dbRecord = getLatestRecallRecord(env);
      expect(dbRecord).not.toBeNull();
      expect(dbRecord?.raw_input).toBe(longInput);
      expect(dbRecord?.output).toBe("FAIL test/integration.test.ts");
      expect(dbRecord?.raw_estimated_tokens).toBeGreaterThan(100);
      expect(dbRecord?.output_estimated_tokens).toBeGreaterThan(0);

      // Verify observe record matches requestId
      const observeContent = await Bun.file(env.CONDENSE_OBSERVE_PATH).text();
      const observeParsed = JSON.parse(observeContent.trim().split("\n")[0]);
      expect(observeParsed.requestId).toBe(dbRecord?.request_id);
      expect(observeParsed.rawEstimatedTokens).toBe(dbRecord?.raw_estimated_tokens);
      expect(observeParsed.outputEstimatedTokens).toBe(dbRecord?.output_estimated_tokens);

      // 2. Bypass log (short log) -> should NOT record recall
      const emptyEnv = {
        CONDENSE_RECALL_PATH: path.join(dir, "recall2.db"),
        CONDENSE_OBSERVE_PATH: path.join(dir, "observe2.jsonl")
      };

      const bypassSession = new CondenseSession({
        cwd: dir,
        applySkipPolicy: true,
        summarizer: {
          summarizeBatch: async () => "summary",
          summarizeWatch: async () => "watch"
        },
        runtimeConfig: {
          question: "what failed?",
          showStats: false,
          model: "condense-v2",
          host: "http://127.0.0.1:11434/v1",
          timeoutMs: 5000,
          provider: "local",
          localBackend: "llamacpp",
          localConcurrency: 5,
          datasetEnabled: false,
          autoLearn: false,
          autoPromoteScopes: []
        },
        env: emptyEnv,
        stdout: { write: () => {} } as any,
        stderr: { write: () => {} } as any
      });

      bypassSession.push(Buffer.from("short log\n"));
      await bypassSession.end();

      const bypassDb = getLatestRecallRecord(emptyEnv);
      expect(bypassDb).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

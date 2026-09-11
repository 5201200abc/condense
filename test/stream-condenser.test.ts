import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CondenseSession } from "../src/stream-condenser";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createWriter() {
  let value = "";

  return {
    write(chunk: string | Uint8Array) {
      value += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
    read() {
      return value;
    }
  };
}

function createDelayedSummarizer(delayMs: number, response: string) {
  return {
    async summarizeBatch() {
      await sleep(delayMs);
      return response;
    },
    async summarizeWatch() {
      return "unused";
    }
  };
}

describe("CondenseSession", () => {
  let testStatsDir = "";
  const originalStatsPath = process.env.CONDENSE_STATS_PATH;
  const originalObservePath = process.env.CONDENSE_OBSERVE_PATH;
  const originalRecallPath = process.env.CONDENSE_RECALL_PATH;

  beforeAll(async () => {
    testStatsDir = await mkdtemp(path.join(tmpdir(), "condense-test-stats-"));
    process.env.CONDENSE_STATS_PATH = path.join(testStatsDir, "stats.json");
    process.env.CONDENSE_OBSERVE_PATH = path.join(testStatsDir, "observe.jsonl");
    process.env.CONDENSE_RECALL_PATH = path.join(testStatsDir, "recall.db");
  });

  afterAll(async () => {
    if (originalStatsPath !== undefined) {
      process.env.CONDENSE_STATS_PATH = originalStatsPath;
    } else {
      delete process.env.CONDENSE_STATS_PATH;
    }
    if (originalObservePath !== undefined) {
      process.env.CONDENSE_OBSERVE_PATH = originalObservePath;
    } else {
      delete process.env.CONDENSE_OBSERVE_PATH;
    }
    if (originalRecallPath !== undefined) {
      process.env.CONDENSE_RECALL_PATH = originalRecallPath;
    } else {
      delete process.env.CONDENSE_RECALL_PATH;
    }
    if (testStatsDir) {
      await rm(testStatsDir, { recursive: true, force: true });
    }
  });

  it("renders a batch summary", async () => {
    const writer = createWriter();
    const session = new CondenseSession({
      stdout: writer,
      isTTY: false,
      idleMs: 10,
      interactiveGapMs: 5,
      summarizer: {
        summarizeBatch: async () => "All tests passed",
        summarizeWatch: async () => "unused"
      }
    });

    session.push(Buffer.from("test output\n"));
    await session.end();

    expect(writer.read()).toContain("All tests passed\n");
  });

  it("records summarize duration excluding stdin wait", async () => {
    let recordedMs: number | undefined;
    const writer = createWriter();
    const session = new CondenseSession({
      stdout: writer,
      isTTY: false,
      idleMs: 10,
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
      summarizer: createDelayedSummarizer(40, "PASS"),
      onBatchStat: (stat) => {
        recordedMs = stat.durationMs;
      }
    });

    await sleep(120);
    session.push(Buffer.from("PASS test/a.test.ts\nFAIL test/b.test.ts\n"));
    await session.end();

    expect(recordedMs).toBeDefined();
    expect(recordedMs ?? 0).toBeGreaterThanOrEqual(30);
    expect(recordedMs ?? 0).toBeLessThan(110);
  });

  it("writes a dataset record for successful batch output", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-session-dataset-"));
    const datasetPath = path.join(dir, "condense.jsonl");
    const writer = createWriter();

    try {
      const session = new CondenseSession({
        stdout: writer,
        isTTY: false,
        idleMs: 10,
        interactiveGapMs: 5,
        runtimeConfig: {
          question: "Did the tests pass? Return PASS or FAIL.",
          model: "qwen3.5:2b",
          host: "http://127.0.0.1:11434/v1",
          apiKey: "",
          timeoutMs: 90_000,
          datasetEnabled: true
        },
        dataset: {
          enabled: true,
          path: datasetPath
        },
        summarizer: {
          summarizeBatch: async () => "PASS",
          summarizeWatch: async () => "unused"
        }
      });

      session.push(Buffer.from("1 passed\n"));
      await session.end();

      const [line] = (await readFile(datasetPath, "utf8")).trim().split("\n");
      const record = JSON.parse(line);

      expect(writer.read()).toBe("PASS\n");
      expect(record.prompt).toContain("TASK:\ntest_result");
      expect(record.prompt).toContain(
        "QUESTION:\nDid the tests pass? Return PASS or FAIL."
      );
      expect(record.prompt).toContain("INPUT:\n1 passed");
      expect(record.completion).toBe("PASS");
      expect(record.metadata.source).toBe("condense");
      expect(record.metadata.mode).toBe("batch");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes insufficient-information batch output as a negative example", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-session-dataset-"));
    const datasetPath = path.join(dir, "condense.jsonl");
    const writer = createWriter();

    try {
      const session = new CondenseSession({
        stdout: writer,
        isTTY: false,
        idleMs: 10,
        interactiveGapMs: 5,
        runtimeConfig: {
          question: "Did the tests pass? Return PASS or FAIL.",
          model: "qwen3.5:2b",
          host: "http://127.0.0.1:11434/v1",
          apiKey: "",
          timeoutMs: 90_000,
          datasetEnabled: true
        },
        dataset: {
          enabled: true,
          path: datasetPath
        },
        summarizer: {
          summarizeBatch: async () =>
            "condense: Insufficient information to output anything.",
          summarizeWatch: async () => "unused"
        }
      });

      session.push(
        Buffer.from(
          "command started but produced no useful rows, status lines, or final result\n"
        )
      );
      await session.end();

      const [line] = (await readFile(datasetPath, "utf8")).trim().split("\n");
      const record = JSON.parse(line);

      expect(writer.read()).toBe(
        "condense: Insufficient information to output anything.\n"
      );
      expect(record.completion).toBe(
        "condense: Insufficient information to output anything."
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("renders spinner progress and clears it before the final summary", async () => {
    const writer = createWriter();
    const progress = createWriter();
    const session = new CondenseSession({
      stdout: writer,
      progress,
      isTTY: false,
      idleMs: 10,
      interactiveGapMs: 5,
      progressFrameMs: 10,
      summarizer: createDelayedSummarizer(50, "All tests passed")
    });

    await sleep(15);
    session.push(Buffer.from("test output\n"));
    await sleep(25);
    await session.end();

    expect(writer.read()).toContain("All tests passed\n");
    expect(progress.read()).toContain("condense: waiting");
    expect(progress.read()).toContain("condense: summarizing");
    expect(progress.read().endsWith("\r\u001b[2K")).toBe(true);
  });

  it("keeps output clean when progress is disabled", async () => {
    const writer = createWriter();
    const session = new CondenseSession({
      stdout: writer,
      isTTY: false,
      idleMs: 10,
      interactiveGapMs: 5,
      progressFrameMs: 10,
      summarizer: createDelayedSummarizer(50, "All tests passed")
    });

    session.push(Buffer.from("test output\n"));
    await sleep(25);
    await session.end();

    expect(writer.read()).toContain("All tests passed\n");
  });

  it("falls back to the raw input when batch condenseation is empty", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-session-dataset-"));
    const datasetPath = path.join(dir, "condense.jsonl");
    const writer = createWriter();

    try {
      const session = new CondenseSession({
        stdout: writer,
        isTTY: false,
        idleMs: 10,
        interactiveGapMs: 5,
        runtimeConfig: {
          question: "Summarize.",
          model: "qwen3.5:2b",
          host: "http://127.0.0.1:11434/v1",
          apiKey: "",
          timeoutMs: 90_000,
          datasetEnabled: true
        },
        dataset: {
          enabled: true,
          path: datasetPath
        },
        summarizer: {
          summarizeBatch: async () => "",
          summarizeWatch: async () => "unused"
        }
      });

      session.push(Buffer.from("raw payload\n"));
      await session.end();

      expect(writer.read()).toBe("raw payload\n");
      await expect(readFile(datasetPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips dataset writes when disabled", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-session-dataset-"));
    const datasetPath = path.join(dir, "condense.jsonl");
    const writer = createWriter();

    try {
      const session = new CondenseSession({
        stdout: writer,
        isTTY: false,
        idleMs: 10,
        interactiveGapMs: 5,
        runtimeConfig: {
          question: "Did the tests pass?",
          model: "qwen3.5:2b",
          host: "http://127.0.0.1:11434/v1",
          apiKey: "",
          timeoutMs: 90_000,
          datasetEnabled: false
        },
        dataset: {
          enabled: false,
          path: datasetPath
        },
        summarizer: {
          summarizeBatch: async () => "PASS",
          summarizeWatch: async () => "unused"
        }
      });

      session.push(Buffer.from("1 passed\n"));
      await session.end();

      expect(writer.read()).toBe("PASS\n");
      await expect(readFile(datasetPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips dataset writes when the summarizer throws", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-session-dataset-"));
    const datasetPath = path.join(dir, "condense.jsonl");
    const writer = createWriter();

    try {
      const session = new CondenseSession({
        stdout: writer,
        isTTY: false,
        idleMs: 10,
        interactiveGapMs: 5,
        runtimeConfig: {
          question: "Did the tests pass?",
          model: "qwen3.5:2b",
          host: "http://127.0.0.1:11434/v1",
          apiKey: "",
          timeoutMs: 90_000,
          datasetEnabled: true
        },
        dataset: {
          enabled: true,
          path: datasetPath
        },
        summarizer: {
          summarizeBatch: async () => {
            throw new Error("request failed");
          },
          summarizeWatch: async () => "unused"
        }
      });

      session.push(Buffer.from("raw payload\n"));
      await session.end();

      expect(writer.read()).toBe("raw payload\n");
      await expect(readFile(datasetPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("switches to passthrough for interactive prompts", async () => {
    const writer = createWriter();
    let summarizeCalls = 0;
    const session = new CondenseSession({
      stdout: writer,
      isTTY: false,
      idleMs: 50,
      interactiveGapMs: 10,
      summarizer: {
        summarizeBatch: async () => {
          summarizeCalls += 1;
          return "never";
        },
        summarizeWatch: async () => {
          summarizeCalls += 1;
          return "never";
        }
      }
    });

    session.push(Buffer.from("Continue? [y/N]"));
    await sleep(25);
    session.push(Buffer.from("\nyes\n"));
    await session.end();

    expect(writer.read()).toBe("Continue? [y/N]\nyes\n");
    expect(summarizeCalls).toBe(0);
  });

  it("promotes recurring bursts to watch mode", async () => {
    const writer = createWriter();
    let watchCalls = 0;
    const session = new CondenseSession({
      stdout: writer,
      isTTY: false,
      idleMs: 15,
      interactiveGapMs: 5,
      summarizer: {
        summarizeBatch: async () => "unused",
        summarizeWatch: async () => {
          watchCalls += 1;
          return "failure count changed";
        }
      }
    });

    session.push(Buffer.from("watch run\nfailed: 0\n"));
    await sleep(25);
    session.push(Buffer.from("watch run\nfailed: 1\n"));
    await sleep(40);
    await session.end();

    expect(writer.read()).toBe("failure count changed\n");
    expect(watchCalls).toBe(1);
  });

  it("clears the terminal when rendering watch output on a tty", async () => {
    const writer = createWriter();
    const session = new CondenseSession({
      stdout: writer,
      isTTY: true,
      idleMs: 15,
      interactiveGapMs: 5,
      summarizer: {
        summarizeBatch: async () => "unused",
        summarizeWatch: async () => "watch summary"
      }
    });

    session.push(Buffer.from("watch run\nfailed: 0\n"));
    await sleep(25);
    session.push(Buffer.from("watch run\nfailed: 1\n"));
    await sleep(40);
    await session.end();

    expect(writer.read()).toBe("\u001b[2J\u001b[Hwatch summary\n");
  });

  it("keeps ambiguous multi-burst output in batch mode", async () => {
    const writer = createWriter();
    let batchCalls = 0;
    const session = new CondenseSession({
      stdout: writer,
      isTTY: false,
      idleMs: 10,
      interactiveGapMs: 5,
      summarizer: {
        summarizeBatch: async () => {
          batchCalls += 1;
          return "batch summary";
        },
        summarizeWatch: async () => "watch summary"
      }
    });

    session.push(Buffer.from("phase one\n"));
    await sleep(20);
    session.push(Buffer.from("totally different phase two\n"));
    await session.end();

    expect(writer.read()).toBe("batch summary\n");
    expect(batchCalls).toBe(1);
  });

  it("does not promote unrelated three-phase output to watch", async () => {
    const writer = createWriter();
    let batchCalls = 0;
    let watchCalls = 0;
    const session = new CondenseSession({
      stdout: writer,
      isTTY: false,
      idleMs: 10,
      interactiveGapMs: 5,
      summarizer: {
        summarizeBatch: async () => {
          batchCalls += 1;
          return "batch summary";
        },
        summarizeWatch: async () => {
          watchCalls += 1;
          return "watch summary";
        }
      }
    });

    session.push(Buffer.from("alpha phase\n"));
    await sleep(20);
    session.push(Buffer.from("beta section\n"));
    await sleep(20);
    session.push(Buffer.from("gamma tail\n"));
    await session.end();

    expect(writer.read()).toBe("batch summary\n");
    expect(batchCalls).toBe(1);
    expect(watchCalls).toBe(0);
  });

  it("emits a one-time privacy notice on the first dataset write", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-session-notice-"));
    const datasetPath = path.join(dir, "condense.jsonl");
    const runtimeConfig = {
      question: "Did the tests pass?",
      model: "qwen3.5:2b",
      host: "http://127.0.0.1:11434/v1",
      apiKey: "",
      timeoutMs: 90_000,
      datasetEnabled: true
    } as const;

    try {
      const stdoutFirst = createWriter();
      const stderrFirst = createWriter();
      const firstSession = new CondenseSession({
        stdout: stdoutFirst,
        stderr: stderrFirst,
        isTTY: false,
        idleMs: 10,
        interactiveGapMs: 5,
        runtimeConfig,
        dataset: { enabled: true, path: datasetPath },
        summarizer: {
          summarizeBatch: async () => "PASS",
          summarizeWatch: async () => "unused"
        }
      });

      firstSession.push(Buffer.from("1 passed\n"));
      await firstSession.end();

      expect(stderrFirst.read()).toContain("capturing fine-tuning data");
      expect(stderrFirst.read()).toContain(datasetPath);

      const stdoutSecond = createWriter();
      const stderrSecond = createWriter();
      const secondSession = new CondenseSession({
        stdout: stdoutSecond,
        stderr: stderrSecond,
        isTTY: false,
        idleMs: 10,
        interactiveGapMs: 5,
        runtimeConfig,
        dataset: { enabled: true, path: datasetPath },
        summarizer: {
          summarizeBatch: async () => "PASS",
          summarizeWatch: async () => "unused"
        }
      });

      secondSession.push(Buffer.from("1 passed\n"));
      await secondSession.end();

      expect(stderrSecond.read()).not.toContain("capturing fine-tuning data");

      const lines = (await readFile(datasetPath, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not emit the privacy notice when dataset capture is disabled", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-session-notice-off-"));
    const datasetPath = path.join(dir, "condense.jsonl");
    const stdout = createWriter();
    const stderr = createWriter();

    try {
      const session = new CondenseSession({
        stdout,
        stderr,
        isTTY: false,
        idleMs: 10,
        interactiveGapMs: 5,
        runtimeConfig: {
          question: "Did the tests pass?",
          model: "qwen3.5:2b",
          host: "http://127.0.0.1:11434/v1",
          apiKey: "",
          timeoutMs: 90_000,
          datasetEnabled: false
        },
        dataset: { enabled: false, path: datasetPath },
        summarizer: {
          summarizeBatch: async () => "PASS",
          summarizeWatch: async () => "unused"
        }
      });

      session.push(Buffer.from("1 passed\n"));
      await session.end();

      expect(stderr.read()).not.toContain("capturing fine-tuning data");
      await expect(readFile(datasetPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("clears the progress line before switching to interactive passthrough", async () => {
    const writer = createWriter();
    const progress = createWriter();
    const session = new CondenseSession({
      stdout: writer,
      progress,
      isTTY: false,
      idleMs: 50,
      interactiveGapMs: 12,
      progressFrameMs: 10,
      summarizer: {
        summarizeBatch: async () => "never",
        summarizeWatch: async () => "never"
      }
    });

    session.push(Buffer.from("Continue? [y/N]"));
    await sleep(35);
    session.push(Buffer.from("\nyes\n"));
    await session.end();

    expect(writer.read()).toBe("Continue? [y/N]\nyes\n");
    expect(progress.read()).toContain("condense: waiting");
    expect(progress.read().endsWith("\r\u001b[2K")).toBe(true);
  });

  it("does not promote CRLF bursts to watch mode", async () => {
    const writer = createWriter();
    let watchCalls = 0;
    const session = new CondenseSession({
      stdout: writer,
      isTTY: false,
      idleMs: 15,
      interactiveGapMs: 5,
      summarizer: {
        summarizeBatch: async () => "batch",
        summarizeWatch: async () => {
          watchCalls += 1;
          return "watch";
        }
      }
    });

    session.push(Buffer.from("phase one unique alpha\r\n"));
    await sleep(25);
    session.push(Buffer.from("totally different omega\r\n"));
    await sleep(25);
    await session.end();

    expect(watchCalls).toBe(0);
    expect(writer.read()).toContain("batch");
  });

  it("switches from watch mode to interactive when a prompt appears", async () => {
    const writer = createWriter();
    let watchCalls = 0;
    const session = new CondenseSession({
      stdout: writer,
      isTTY: false,
      idleMs: 15,
      interactiveGapMs: 10,
      summarizer: {
        summarizeBatch: async () => "unused",
        summarizeWatch: async () => {
          watchCalls += 1;
          return "failure count changed";
        }
      }
    });

    session.push(Buffer.from("watch run\nfailed: 0\n"));
    await sleep(25);
    session.push(Buffer.from("watch run\nfailed: 1\n"));
    await sleep(25);
    session.push(Buffer.from("Continue? [y/N]"));
    await sleep(25);
    session.push(Buffer.from("\nyes\n"));
    await session.end();

    expect(watchCalls).toBeGreaterThan(0);
    expect(writer.read()).toContain("Continue? [y/N]");
    expect(writer.read()).toContain("yes");
  });
});

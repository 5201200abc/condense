import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendDatasetRecord,
  buildDatasetPrompt,
  buildDatasetRecord,
  inferDatasetRisk,
  inferDatasetTask
} from "../src/dataset";

const itUnixOnly = process.platform === "win32" ? it.skip : it;

describe("dataset", () => {
  it("builds prompt/completion records for batch fine-tuning", () => {
    const record = buildDatasetRecord(
      {
        question: "Did TypeScript pass? Return PASS or FAIL.",
        model: "qwen3.5:2b",
        host: "http://127.0.0.1:11434/v1",
        apiKey: "",
        timeoutMs: 90_000,
        datasetEnabled: true
      },
      "src/app.ts:1:1 - error TS2322",
      "FAIL\nsrc/app.ts TS2322",
      new Date("2026-05-07T19:00:00Z")
    );

    expect(record.prompt).toContain("TASK:\ntypescript_check");
    expect(record.prompt).toContain("QUESTION:\nDid TypeScript pass?");
    expect(record.prompt).toContain("INPUT:\nsrc/app.ts:1:1 - error TS2322");
    expect(record.completion).toBe("FAIL\nsrc/app.ts TS2322");
    expect(record.metadata).toEqual({
      source: "condense",
      task: "typescript_check",
      risk: "low",
      mode: "batch",
      created_at: "2026-05-07T19:00:00.000Z"
    });
  });

  it("classifies common condense tasks and risk", () => {
    expect(inferDatasetTask("Did the tests pass? Return PASS or FAIL.")).toBe(
      "test_result"
    );
    expect(inferDatasetTask("Did TypeScript pass? Include TS codes.")).toBe(
      "typescript_check"
    );
    expect(inferDatasetTask("Is this terraform plan safe?")).toBe(
      "terraform_plan"
    );
    expect(inferDatasetTask("Extract vulnerabilities. Return valid JSON only.")).toBe(
      "json_extraction"
    );
    expect(inferDatasetTask("Is this SAFE, REVIEW, or UNSAFE?")).toBe(
      "safe_review"
    );
    expect(inferDatasetTask("Summarize this output.")).toBe("generic");

    expect(inferDatasetRisk("Is this terraform plan safe?", "terraform_plan")).toBe(
      "high"
    );
    expect(inferDatasetRisk("Did the deploy pipeline pass?", "generic")).toBe(
      "medium"
    );
    expect(inferDatasetRisk("Did lint pass?", "pass_fail")).toBe("low");
  });

  it("builds the requested prompt shape", () => {
    expect(buildDatasetPrompt("contract", "test_result", "question", "input")).toBe(
      "contract\n\nTASK:\ntest_result\n\nQUESTION:\nquestion\n\nINPUT:\ninput"
    );
  });

  it("appends JSONL and creates the parent directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-dataset-"));
    const datasetPath = path.join(dir, "nested", "condense.jsonl");

    try {
      const record = {
        prompt: "prompt",
        completion: "completion",
        metadata: {
          source: "condense" as const,
          task: "generic" as const,
          risk: "low" as const,
          mode: "batch" as const,
          created_at: "2026-05-07T19:00:00.000Z"
        }
      };

      await appendDatasetRecord({ enabled: true, path: datasetPath }, record);
      await appendDatasetRecord({ enabled: true, path: datasetPath }, record);

      const lines = (await readFile(datasetPath, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual(record);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports firstWrite=true on initial append and false thereafter", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-dataset-"));
    const datasetPath = path.join(dir, "nested", "condense.jsonl");

    try {
      const record = {
        prompt: "p",
        completion: "c",
        metadata: {
          source: "condense" as const,
          task: "generic" as const,
          risk: "low" as const,
          mode: "batch" as const,
          created_at: "2026-05-07T19:00:00.000Z"
        }
      };

      const first = await appendDatasetRecord(
        { enabled: true, path: datasetPath },
        record
      );
      const second = await appendDatasetRecord(
        { enabled: true, path: datasetPath },
        record
      );

      expect(first).toEqual({ written: true, firstWrite: true });
      expect(second).toEqual({ written: true, firstWrite: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns written=false when disabled and does not create the file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-dataset-"));
    const datasetPath = path.join(dir, "condense.jsonl");

    try {
      const record = {
        prompt: "p",
        completion: "c",
        metadata: {
          source: "condense" as const,
          task: "generic" as const,
          risk: "low" as const,
          mode: "batch" as const,
          created_at: "2026-05-07T19:00:00.000Z"
        }
      };

      const result = await appendDatasetRecord(
        { enabled: false, path: datasetPath },
        record
      );

      expect(result).toEqual({ written: false, firstWrite: false });
      await expect(readFile(datasetPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  itUnixOnly("creates the JSONL file with mode 0o600", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-dataset-"));
    const datasetPath = path.join(dir, "condense.jsonl");

    try {
      const record = {
        prompt: "p",
        completion: "c",
        metadata: {
          source: "condense" as const,
          task: "generic" as const,
          risk: "low" as const,
          mode: "batch" as const,
          created_at: "2026-05-07T19:00:00.000Z"
        }
      };

      await appendDatasetRecord(
        { enabled: true, path: datasetPath },
        record
      );

      const stats = await stat(datasetPath);
      expect(stats.mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

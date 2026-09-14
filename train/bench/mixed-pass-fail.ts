import { readFileSync } from "node:fs";

export interface MixedPassFailCase {
  id: string;
  task: "pass_fail";
  question: string;
  output: string;
  gold: string;
  expectedVerdict: "FAIL";
  tags: string[];
  provenance?: {
    project: string;
    requestId: string;
  };
}

const EXPLICIT_TEST_FAILURES = [
  /^\s*test\s+.+\.\.\.\s+FAILED\b/im,
  /^\s*test result:\s*FAILED\b/im,
  /^\s*error:\s*test failed\b/im,
  /^\s*FAIL\s+\S+/m,
  /^\s*Test Suites:\s*[1-9]\d* failed\b/im,
  /^\s*Tests:\s*[1-9]\d* failed\b/im
];

export function hasExplicitTestFailure(source: string): boolean {
  return EXPLICIT_TEST_FAILURES.some((pattern) => pattern.test(source));
}

export function firstPassFailVerdict(summary: string): "PASS" | "FAIL" | undefined {
  const withoutThinking = summary.includes("</think>")
    ? summary.slice(summary.lastIndexOf("</think>") + "</think>".length)
    : summary;
  return withoutThinking.trim().match(/^(PASS|FAIL)\b/)?.[1] as
    | "PASS"
    | "FAIL"
    | undefined;
}

export function acceptsMixedPassFailSummary(summary: string): boolean {
  return firstPassFailVerdict(summary) === "FAIL";
}

export function loadMixedPassFailCases(file: string): MixedPassFailCase[] {
  const rows = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as MixedPassFailCase);

  if (rows.length === 0) {
    throw new Error("mixed PASS/FAIL regression set is empty");
  }
  for (const row of rows) {
    if (!row.id || row.expectedVerdict !== "FAIL") {
      throw new Error(`invalid mixed PASS/FAIL regression: ${row.id || "missing id"}`);
    }
    if (!row.tags.includes("mixed_pass_fail")) {
      throw new Error(`mixed PASS/FAIL regression missing tag: ${row.id}`);
    }
    if (!hasExplicitTestFailure(row.output)) {
      throw new Error(`mixed PASS/FAIL regression has no explicit test failure: ${row.id}`);
    }
  }
  return rows;
}

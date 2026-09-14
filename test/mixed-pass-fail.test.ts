import { describe, expect, it } from "bun:test";
import path from "node:path";

import {
  acceptsMixedPassFailSummary,
  firstPassFailVerdict,
  hasExplicitTestFailure,
  loadMixedPassFailCases
} from "../train/bench/mixed-pass-fail";

const FIXTURES = path.join(
  import.meta.dir,
  "../train/bench/mixed_pass_fail_regressions.jsonl"
);

describe("mixed PASS/FAIL v2 quality gate", () => {
  it("freezes both confirmed transit failures and related variants", () => {
    const rows = loadMixedPassFailCases(FIXTURES);

    expect(rows.map((row) => row.id)).toEqual([
      "transit-61138a1f",
      "transit-8c15ad97",
      "mixed-failed-between-passes",
      "mixed-error-after-success-summary",
      "mixed-failure-before-later-pass-suite",
      "mixed-jest-fail-amid-pass"
    ]);
    expect(rows.every((row) => hasExplicitTestFailure(row.output))).toBe(true);
    expect(rows.every((row) => row.expectedVerdict === "FAIL")).toBe(true);
  });

  it("requires FAIL and rejects PASS regardless of explanation", () => {
    expect(acceptsMixedPassFailSummary("FAIL\nauth::expired_token")).toBe(true);
    expect(acceptsMixedPassFailSummary("PASS")).toBe(false);
    expect(acceptsMixedPassFailSummary("PASS\nOne suite failed later.")).toBe(false);
    expect(acceptsMixedPassFailSummary("The result is FAIL.")).toBe(false);
    expect(firstPassFailVerdict("</think>\nFAIL\nfailing_test")).toBe("FAIL");
  });

  it("recognizes explicit failures from Rust and Jest logs", () => {
    expect(hasExplicitTestFailure("test auth::expired ... FAILED")).toBe(true);
    expect(hasExplicitTestFailure("error: test failed, to rerun pass `-p app`")).toBe(true);
    expect(hasExplicitTestFailure("FAIL src/auth.test.ts\nPASS src/db.test.ts")).toBe(true);
    expect(hasExplicitTestFailure("test result: ok. 12 passed; 0 failed")).toBe(false);
  });
});

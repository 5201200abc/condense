import { describe, expect, it } from "bun:test";
import { extractCriticalEvidence, assessEvidence, enforceEvidenceContract, EvidenceBudgetExceeded } from "../src/evidence";
import { fitInput } from "../src/prompt";

const question = "PASS or FAIL? List failing items with their relevant raw error messages.";

describe("critical evidence pipeline", () => {
  for (const position of ["start", "middle", "end"]) {
    it(`preserves the error, failing item and location at the ${position} of a long log`, () => {
      const noise = "info: healthy iteration\n".repeat(1200);
      const block = "FAIL test/payment.test.ts\nTypeError: payment.total is undefined\n    at charge (/app/payment.ts:87:12)\n";
      const input = position === "start" ? block + noise : position === "end" ? noise + block : noise + block + noise;
      const fitted = fitInput(input, 8000);
      expect(fitted.length).toBeLessThanOrEqual(8000);
      expect(fitted).toContain("FAIL test/payment.test.ts");
      expect(fitted).toContain("TypeError: payment.total is undefined");
      expect(fitted).toContain("/app/payment.ts:87:12");
    });
  }

  it("rejects partial detail and preserves independent errors", () => {
    const input = "info: setup\n".repeat(200) + "FAIL test/a.test.ts\nTypeError: first failure\n    at run (/app/a.ts:12:3)\nFAIL test/b.test.ts\nError: second failure\n    at run (/app/b.ts:24:5)\n";
    const result = enforceEvidenceContract(input, "FAIL\nTypeError: first failure", question);
    expect(result.quality?.action).toBe("repair");
    expect(result.output).toContain("second failure");
    expect(result.output).toContain("test/a.test.ts");
    expect(result.output).toContain("test/b.test.ts");
    expect(result.output).toContain("/app/b.ts:24:5");
    expect(result.output.length).toBeLessThan(input.length / 2);
    expect(result.quality?.retained).toBe(result.quality?.required);
  });

  it("accepts a complete model summary and leaves status-only requests valid", () => {
    const input = "info\n".repeat(100) + "TypeError: bad value\n    at run (/app/a.ts:2:3)\n";
    const complete = "FAIL\nTypeError: bad value\n    at run (/app/a.ts:2:3)";
    expect(enforceEvidenceContract(input, complete, question).quality?.modelContractPassed).toBe(true);
    expect(enforceEvidenceContract(input, "FAIL", "PASS or FAIL?").output).toBe("FAIL");
    expect(enforceEvidenceContract(input, "PASS", "PASS or FAIL?").output).toBe("FAIL");
    const unknown = enforceEvidenceContract("WARNING: recovered from TimeoutError", "FAIL", question);
    expect(unknown.output).toBe("WARNING: recovered from TimeoutError");
    expect(unknown.quality?.rejectionReason).toBe("unverified_outcome");
  });

  it("preserves destructive evidence and rejects an unsafe SAFE verdict", () => {
    const input = "refreshing resources\n".repeat(200) + "# module.db.aws_db_instance.main will be destroyed\nPlan: 0 to add, 0 to change, 1 to destroy.\n";
    const result = enforceEvidenceContract(input, "SAFE", "SAFE or UNSAFE? List risks.");
    expect(result.output).toStartWith("UNSAFE\n");
    expect(result.output).toContain("module.db.aws_db_instance.main will be destroyed");
    expect(result.quality?.action).toBe("repair");
  });

  it("deduplicates repeated errors without losing distinct frames", () => {
    const input = "Error: duplicate\n    at first (/app/a.ts:1:2)\nError: duplicate\n    at second (/app/b.ts:3:4)\n";
    const evidence = extractCriticalEvidence(input);
    expect(evidence.anchors.filter((a) => a === "Error: duplicate")).toHaveLength(1);
    expect(assessEvidence(evidence, evidence.lines.join("\n"))).toBe(evidence.anchors.length);
    expect(evidence.lines.join("\n")).toContain("/app/b.ts:3:4");
  });

  it("refuses to silently truncate an oversized critical error", () => {
    const input = "Error: " + "critical payload ".repeat(900);
    expect(() => fitInput(input, 8000)).toThrow(EvidenceBudgetExceeded);
    const result = enforceEvidenceContract(input, "FAIL", question);
    expect(result.output).toBe(input);
    expect(result.quality?.action).toBe("raw");
    expect(result.quality?.contractPassed).toBe(false);
  });
});

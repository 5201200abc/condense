import { describe, expect, it } from "bun:test";
import { enforceEvidenceContract } from "../src/evidence";
import { fitInput } from "../src/prompt";
import { normalizeForModel } from "../src/text";
import { evaluateRobustnessOutput, robustnessCases } from "../train/bench/robustness-cases";

describe("independently labelled robustness cases", () => {
  for (const fixture of robustnessCases) {
    it(`preserves gold evidence and the requested contract: ${fixture.id}`, () => {
      // Fail these checks if the manually labelled evidence is not in the source.
      const source = normalizeForModel(fixture.input);
      for (const anchor of fixture.required) expect(source).toContain(anchor);
      const modelInput = fitInput(source, 8000);
      expect(modelInput.length).toBeLessThanOrEqual(8000);
      for (const anchor of fixture.inputRequired) expect(modelInput).toContain(anchor);

      const result = enforceEvidenceContract(fixture.input, fixture.verdict, fixture.question);
      expect(evaluateRobustnessOutput(fixture, result.output).contractPassed).toBe(true);
      if (fixture.guard) {
        expect(result.quality?.action).toBe("repair");
        expect(result.output.length).toBeLessThan(fixture.input.length / 2);
      } else {
        expect(result.quality?.action).not.toBe("repair");
        expect(result.output).toBe(fixture.verdict);
      }
    });
  }

  it("does not treat a necessary status-only correction as a false repair", () => {
    const fixture = robustnessCases.find((row) => row.id === "failure-status-only")!;
    const result = enforceEvidenceContract(fixture.input, "PASS", fixture.question);
    expect(result.output).toBe("FAIL");
    expect(result.quality?.required).toBe(0);
  });
});

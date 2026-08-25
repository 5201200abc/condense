import { describe, expect, it } from "bun:test";

import {
  hasPromptLikeTail,
  looksLikeBadDistillation,
  normalizeForModel,
  structuralSimilarity
} from "../src/text";

describe("text helpers", () => {
  it("normalizes ansi sequences and blank lines", () => {
    expect(normalizeForModel("\u001b[31merror\u001b[0m\r\n\r\n\r\nok")).toBe(
      "error\n\nok"
    );
  });

  it("detects prompt-like tails", () => {
    expect(hasPromptLikeTail("Continue? [y/N]")).toBe(true);
    expect(hasPromptLikeTail("random log line")).toBe(false);
  });

  it("scores structurally similar bursts highly", () => {
    expect(
      structuralSimilarity("watch run\nfailed: 0\n", "watch run\nfailed: 1\n")
    ).toBeGreaterThan(0.5);
  });

  it("treats echoed input as a bad condenseation", () => {
    const input = "x".repeat(1500);
    expect(looksLikeBadDistillation(input, input)).toBe(true);
  });
});

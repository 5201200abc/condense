import { describe, expect, it } from "bun:test";

import {
  hasPromptLikeTail,
  hasRedrawSignal,
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

  it("does not treat CRLF as a redraw signal", () => {
    expect(hasRedrawSignal("line one\r\nline two\r\n")).toBe(false);
    expect(hasRedrawSignal("progress\rnext")).toBe(true);
    expect(hasRedrawSignal("\u001b[2Jcleared")).toBe(true);
  });

  it("does not treat moderate long-input compression as a bad distillation", () => {
    const input = "x".repeat(1500);
    expect(looksLikeBadDistillation(input, "x".repeat(1200))).toBe(false);
    expect(looksLikeBadDistillation(input, "x".repeat(1480))).toBe(true);
  });
});

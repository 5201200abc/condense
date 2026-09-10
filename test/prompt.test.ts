import { describe, expect, it } from "bun:test";

import { buildBatchPrompt, buildFixedBatchSystemPrompt } from "../src/prompt";

describe("batch prompt split", () => {
  it("keeps the system prompt fixed when DSL memory and command output change", () => {
    const system = buildFixedBatchSystemPrompt();
    const withoutDsl = buildBatchPrompt("Did tests pass?", "1 passed");
    const withDsl = buildBatchPrompt("Did tests pass?", "2 failed", {
      dslMemory: "A = auth fix (alias, project)"
    });

    expect(withoutDsl.system).toBe(system);
    expect(withDsl.system).toBe(system);
    expect(system).toContain("output only NONE");
    expect(system).not.toContain("Examples:");
    expect(system).not.toContain("Inline variable rule");
    expect(system).not.toContain("worker-xy");
    expect(system).not.toContain("Known /condense DSL memory");
    expect(withDsl.user).toContain("Known /condense DSL memory");
    expect(withDsl.user).toContain("A = auth fix (alias, project)");
    expect(withDsl.user).toContain("2 failed");
    expect(withDsl.user).toContain("Did tests pass?");
  });
});

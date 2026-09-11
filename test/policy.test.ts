import { describe, expect, it } from "bun:test";

import {
  condenseSkipReason,
  shouldCondense
} from "../src/policy";

function repeat(line: string, count: number): string {
  return Array.from({ length: count }, () => line).join("\n");
}

describe("condense skip policy", () => {
  it("bypasses short commands", () => {
    expect(condenseSkipReason("ls\nfile.txt\n")).toBe("short");
    expect(shouldCondense(repeat("ok", 20))).toBe(false);
  });

  it("condenses long test logs", () => {
    const input = `${repeat("PASS test/ok.test.ts", 120)}\nFAIL test/auth.test.ts\n`;
    expect(condenseSkipReason(input, "Did tests pass? Return PASS or FAIL.")).toBeNull();
  });

  it("bypasses whole-repo architecture questions", () => {
    const input = repeat("export function handle() {}", 200);
    expect(
      condenseSkipReason(
        input,
        "通读输入的所有仓库文件。给出具体架构、调用链、职责。"
      )
    ).toBe("dense");
    expect(
      condenseSkipReason(
        input,
        "Explain the actual source responsibilities, main control flow"
      )
    ).toBe("dense");
  });

  it("bypasses source dumps and git diffs even with a log-style question", () => {
    const source = repeat("import { foo } from './bar';\nexport class Service {}", 80);
    expect(condenseSkipReason(source, "Did tests pass?")).toBe("dense");
    const diff = `${repeat("diff --git a/src/a.ts b/src/a.ts", 40)}\n${repeat("+added", 80)}`;
    expect(condenseSkipReason(diff, "What changed?")).toBe("dense");
  });

  it("does not treat compiler and terraform logs as source dumps", () => {
    const tsc = `${repeat("src/app.ts(10,5): error TS2339: bad", 120)}\n`;
    expect(condenseSkipReason(tsc, "Did build succeed?")).toBeNull();
    const terraform = `${repeat("  # aws_db_instance.main will be destroyed", 120)}\nPlan: 0 to add, 0 to change, 1 to destroy.\n`;
    expect(condenseSkipReason(terraform, "Is this safe?")).toBeNull();
  });
});

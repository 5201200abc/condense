import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const cli = path.join(root, "src", "cli.ts");
const describeUnixOnly = process.platform === "win32" ? describe.skip : describe;

describeUnixOnly("pipeline exit behavior", () => {
  it("mirrors the upstream exit with pipefail", () => {
    const result = spawnSync(
      "bash",
      [
        "-lc",
        `set -o pipefail; (exit 7) | bun run ${cli} "is this safe?" >/dev/null; printf "%s" $?`
      ],
      {
        cwd: root,
        encoding: "utf8"
      }
    );

    expect(result.stdout).toBe("7");
  });

  it("returns the condense exit without pipefail", () => {
    const result = spawnSync(
      "bash",
      [
        "-lc",
        `(exit 7) | bun run ${cli} "is this safe?" >/dev/null; printf "%s" $?`
      ],
      {
        cwd: root,
        encoding: "utf8"
      }
    );

    expect(result.stdout).toBe("0");
  });
});

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const installSh = readFileSync(
  path.resolve(import.meta.dir, "../install.sh"),
  "utf8"
);

describe("install.sh", () => {
  it("does not download GitHub CLI tarballs", () => {
    expect(installSh).not.toContain(".tar.gz");
    expect(installSh).not.toContain("releases/download");
    expect(installSh).toContain("npm install -g");
    expect(installSh).toContain("5201200abc/condense");
  });
});

import { describe, expect, it } from "bun:test";
import {
  getCurrentPlatformKey,
  getPlatformTarget,
  PLATFORM_TARGETS,
  selectPlatformTargets
} from "../scripts/platform-targets";

describe("platform targets", () => {
  it("defines every supported platform target exactly once", () => {
    expect(PLATFORM_TARGETS).toHaveLength(5);
    expect(new Set(PLATFORM_TARGETS.map((target) => target.key)).size).toBe(
      PLATFORM_TARGETS.length
    );
    expect(
      new Set(PLATFORM_TARGETS.map((target) => target.packageName)).size
    ).toBe(PLATFORM_TARGETS.length);
  });

  it("selects all targets when buildAll is enabled", () => {
    const targets = selectPlatformTargets({ buildAll: true });
    expect(targets.map((target) => target.key)).toEqual(
      PLATFORM_TARGETS.map((target) => target.key)
    );
  });

  it("selects the current platform target by default", () => {
    const targets = selectPlatformTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]?.key).toBe(getCurrentPlatformKey());
  });

  it("returns no target for unsupported platforms", () => {
    expect(
      selectPlatformTargets({
        platform: "haiku",
        arch: "x64"
      })
    ).toEqual([]);
  });

  it("keeps Windows binary paths aligned", () => {
    const windowsTarget = getPlatformTarget("win32-x64");
    expect(windowsTarget).toBeDefined();
    expect(windowsTarget?.binaryName).toBe("condense.exe");
    expect(windowsTarget?.packageBinaryPath).toBe(
      "packages/condense-win32-x64/bin/condense.exe"
    );
    expect(windowsTarget?.buildOutputPath).toBe(
      ".dist/bun-windows-x64/condense.exe"
    );
    expect(windowsTarget?.os).toEqual(["win32"]);
    expect(windowsTarget?.cpu).toEqual(["x64"]);
  });
});

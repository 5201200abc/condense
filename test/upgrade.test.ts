import { describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  getCurrentPlatformKey,
  getPlatformTarget
} from "../scripts/platform-targets";
import {
  publishedVersionIfThisProject,
  runUpgradeCommand
} from "../src/upgrade";

const foreignNpm = async () =>
  new Response(
    JSON.stringify({
      version: "0.0.1",
      repository: { url: "https://github.com/Gozala/condense.git" }
    }),
    { status: 200 }
  );

describe("npm upgrade identity", () => {
  it("rejects a public condense package that is not this repository", () => {
    expect(
      publishedVersionIfThisProject({
        version: "0.0.1",
        repository: { url: "https://github.com/Gozala/condense.git" }
      })
    ).toBeNull();
    expect(publishedVersionIfThisProject({ version: "0.0.1" })).toBeNull();
  });

  it("accepts the npm latest document when the repository is this project", () => {
    expect(
      publishedVersionIfThisProject({
        version: "0.1.0",
        repository: { url: "https://github.com/5201200abc/condense" }
      })
    ).toBe("0.1.0");
  });

  it("tells the user not to npm-install a foreign condense package when no checkout binary exists", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "condense-upgrade-empty-"));
    const text = await runUpgradeCommand(foreignNpm, {
      cwd,
      env: { HOME: cwd, CONDENSE_INSTALL_DIR: path.join(cwd, "bin") }
    });

    expect(text).toContain("Current version: v");
    expect(text).toContain('Public npm package "condense" is not this project yet.');
    expect(text).not.toContain("install.sh");
    expect(text).not.toContain(".tar.gz");
    expect(text).not.toContain("Installed ");
  });

  it("prints npm install -g when this project is on npm and newer", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "condense-upgrade-npm-"));
    const text = await runUpgradeCommand(
      async () =>
        new Response(
          JSON.stringify({
            version: "9.9.9",
            repository: { url: "git+https://github.com/5201200abc/condense.git" }
          }),
          { status: 200 }
        ),
      {
        cwd,
        env: { HOME: cwd, CONDENSE_INSTALL_DIR: path.join(cwd, "bin") }
      }
    );

    expect(text).toContain("Latest version : v9.9.9");
    expect(text).toContain("npm install -g condense@latest");
    expect(text).not.toContain("install.sh");
  });

  it("copies the checkout platform binary when npm is not this project", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "condense-upgrade-local-"));
    const installDir = path.join(root, "install");
    const target = getPlatformTarget(getCurrentPlatformKey());
    if (!target) {
      throw new Error("unsupported platform for upgrade test");
    }
    const source = path.join(root, target.packageBinaryPath);
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "packages/cli"), { recursive: true });
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(path.join(root, "src/cli.ts"), "");
    await writeFile(path.join(root, "packages/cli/package.json"), "{}");
    await writeFile(
      source,
      "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 0.1.0; fi\n"
    );
    await chmod(source, 0o755);

    const text = await runUpgradeCommand(foreignNpm, {
      cwd: root,
      env: {
        HOME: root,
        CONDENSE_INSTALL_DIR: installDir
      }
    });

    expect(text).toContain(`Installed ${path.join(installDir, target.binaryName)}`);
    expect(text).toContain("Updated to v0.1.0");
    expect(text).not.toContain("npm install -g condense@latest");
  });
});

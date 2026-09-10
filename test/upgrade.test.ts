import { describe, expect, it } from "bun:test";

import {
  publishedVersionIfThisProject,
  runUpgradeCommand
} from "../src/upgrade";

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

  it("tells the user not to npm-install a foreign condense package", async () => {
    const text = await runUpgradeCommand(async () =>
      new Response(
        JSON.stringify({
          version: "0.0.1",
          repository: { url: "https://github.com/Gozala/condense.git" }
        }),
        { status: 200 }
      )
    );

    expect(text).toContain("Current version: v");
    expect(text).toContain('Public npm package "condense" is not this project yet.');
    expect(text).not.toContain("install.sh");
    expect(text).not.toContain(".tar.gz");
  });

  it("prints npm install -g when this project is on npm and newer", async () => {
    const text = await runUpgradeCommand(async () =>
      new Response(
        JSON.stringify({
          version: "9.9.9",
          repository: { url: "git+https://github.com/5201200abc/condense.git" }
        }),
        { status: 200 }
      )
    );

    expect(text).toContain("Latest version : v9.9.9");
    expect(text).toContain("npm install -g condense@latest");
    expect(text).not.toContain("install.sh");
  });
});

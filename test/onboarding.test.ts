import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import type { RuntimeConfig } from "../src/config";
import { runOnboarding, warmupLocalModel } from "../src/onboarding";

function captureOutput(): { output: Writable; read: () => string } {
  let text = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    }
  });

  return {
    output,
    read: () => text
  };
}

describe("onboarding", () => {
  it("shows local model download progress and warms the resolved local runtime", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-onboarding-warm-"));
    const configPath = path.join(dir, "config.json");
    const { output, read } = captureOutput();
    let warmedConfig: RuntimeConfig | null = null;

    try {
      await runOnboarding({
        env: {
          ...process.env,
          HOME: dir,
          USERPROFILE: dir,
          CONDENSE_CONFIG_PATH: configPath,
          CONDENSE_ONBOARDING_TUI: "false"
        },
        input: Readable.from(["\n\n2\n127.0.0.1\n19009\n120000\nn\n"]),
        output,
        prepareLocalModel: async (config, onProgress) => {
          warmedConfig = config;
          onProgress?.(1);
        }
      });

      expect(read()).toContain("(0%) Downloading and loading Condense local model");
      expect(read()).toContain("(1%) Downloading and loading Condense local model");
      expect(read()).toContain("Local Condense model ready");
      expect(warmedConfig?.provider).toBe("local");
      expect(warmedConfig?.localConcurrency).toBe(2);
      expect(warmedConfig?.host).toBe("http://127.0.0.1:19009/v1");
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        provider: "local",
        localConcurrency: 2,
        localHost: "127.0.0.1",
        localPort: 19009,
        timeoutMs: 120000
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("warms the local model without interactive onboarding", async () => {
    const { output, read } = captureOutput();
    let warmedConfig: RuntimeConfig | null = null;

    await warmupLocalModel({
      env: process.env,
      persisted: {
        provider: "local",
        localHost: "127.0.0.1",
        localPort: 19009
      },
      output,
      prepareLocalModel: async (config, onProgress) => {
        warmedConfig = config;
        onProgress?.(1);
      }
    });

    expect(read()).toContain("(0%) Downloading and loading Condense local model");
    expect(read()).toContain("(1%) Downloading and loading Condense local model");
    expect(read()).toContain("Local Condense model ready");
    expect(warmedConfig?.provider).toBe("local");
    expect(warmedConfig?.localHost).toBe("127.0.0.1");
    expect(warmedConfig?.localPort).toBe(19009);
  });

  it("skips warmup when provider is external", async () => {
    const { output, read } = captureOutput();
    let prepared = false;

    await warmupLocalModel({
      env: process.env,
      persisted: { provider: "external" },
      output,
      prepareLocalModel: async () => {
        prepared = true;
      }
    });

    expect(prepared).toBe(false);
    expect(read()).toContain("condense warmup skipped: provider is not local.");
  });
});

import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  readPersistedConfig,
  resolveConfigPath,
  setPersistedConfigValue
} from "../src/user-config";

describe("user config", () => {
  it("writes and reads persisted config values", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-config-"));
    const configPath = path.join(dir, "config.json");

    try {
      await setPersistedConfigValue(
        { CONDENSE_CONFIG_PATH: configPath },
        "model",
        "qwen3.5:2b"
      );
      await setPersistedConfigValue(
        { CONDENSE_CONFIG_PATH: configPath },
        "dataset-enabled",
        false
      );
      await setPersistedConfigValue(
        { CONDENSE_CONFIG_PATH: configPath },
        "dataset-path",
        "/tmp/condense.jsonl"
      );
      await setPersistedConfigValue(
        { CONDENSE_CONFIG_PATH: configPath },
        "provider",
        "local"
      );
      await setPersistedConfigValue(
        { CONDENSE_CONFIG_PATH: configPath },
        "local-backend",
        "llamacpp"
      );
      await setPersistedConfigValue(
        { CONDENSE_CONFIG_PATH: configPath },
        "local-concurrency",
        5
      );
      await setPersistedConfigValue(
        { CONDENSE_CONFIG_PATH: configPath },
        "local-host",
        "127.0.0.1"
      );
      await setPersistedConfigValue(
        { CONDENSE_CONFIG_PATH: configPath },
        "local-port",
        8009
      );

      expect(await readPersistedConfig({ CONDENSE_CONFIG_PATH: configPath })).toEqual({
        model: "qwen3.5:2b",
        datasetEnabled: false,
        datasetPath: "/tmp/condense.jsonl",
        provider: "local",
        localBackend: "llamacpp",
        localConcurrency: 5,
        localHost: "127.0.0.1",
        localPort: 8009
      });

      const raw = JSON.parse(await readFile(configPath, "utf8"));
      expect(raw).toEqual({
        model: "qwen3.5:2b",
        datasetEnabled: false,
        datasetPath: "/tmp/condense.jsonl",
        provider: "local",
        localBackend: "llamacpp",
        localConcurrency: 5,
        localHost: "127.0.0.1",
        localPort: 8009
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves config path from explicit path, xdg, and Windows env vars", () => {
    const appData = "C:\\Users\\me\\AppData\\Roaming";
    const localAppData = "C:\\Users\\me\\AppData\\Local";
    const userProfile = "C:\\Users\\me";

    expect(
      resolveConfigPath({
        CONDENSE_CONFIG_PATH: "/tmp/custom-condense.json"
      })
    ).toBe("/tmp/custom-condense.json");

    expect(
      resolveConfigPath({
        XDG_CONFIG_HOME: "/tmp/xdg"
      })
    ).toBe(path.join("/tmp/xdg", "condense", "config.json"));

    expect(
      resolveConfigPath({
        APPDATA: appData
      })
    ).toBe(path.join(appData, "condense", "config.json"));

    expect(
      resolveConfigPath({
        APPDATA: appData,
        LOCALAPPDATA: localAppData
      })
    ).toBe(path.join(appData, "condense", "config.json"));

    expect(
      resolveConfigPath({
        LOCALAPPDATA: localAppData
      })
    ).toBe(path.join(localAppData, "condense", "config.json"));

    expect(
      resolveConfigPath({
        USERPROFILE: userProfile
      })
    ).toBe(
      path.join(userProfile, "AppData", "Roaming", "condense", "config.json")
    );
  });
});

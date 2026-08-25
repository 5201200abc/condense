import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ConfigKey, PersistedConfig } from "./config";

export function resolveConfigBaseDir(env: NodeJS.ProcessEnv): string {
  const appData = env.APPDATA?.trim();

  if (appData) {
    return path.join(appData, "condense");
  }

  const localAppData = env.LOCALAPPDATA?.trim();

  if (localAppData) {
    return path.join(localAppData, "condense");
  }

  const xdg = env.XDG_CONFIG_HOME?.trim();

  if (xdg) {
    return path.join(xdg, "condense");
  }

  const userProfile = env.USERPROFILE?.trim();

  if (userProfile) {
    return path.join(userProfile, "AppData", "Roaming", "condense");
  }

  const home = env.HOME?.trim();

  if (!home) {
    throw new Error("Could not resolve a home directory for condense config.");
  }

  return path.join(home, ".config", "condense");
}

export function resolveConfigPath(env: NodeJS.ProcessEnv): string {
  const explicit = (env.CONDENSE_CONFIG_PATH ?? env.DISTILL_CONFIG_PATH)?.trim();

  if (explicit) {
    return explicit;
  }

  return path.join(resolveConfigBaseDir(env), "config.json");
}

export async function readPersistedConfig(
  env: NodeJS.ProcessEnv
): Promise<PersistedConfig> {
  const configPath = resolveConfigPath(env);

  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as PersistedConfig;

    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

export async function writePersistedConfig(
  env: NodeJS.ProcessEnv,
  config: PersistedConfig
): Promise<void> {
  const configPath = resolveConfigPath(env);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export async function setPersistedConfigValue(
  env: NodeJS.ProcessEnv,
  key: ConfigKey,
  value: string | number | boolean
): Promise<PersistedConfig> {
  const current = await readPersistedConfig(env);

  if (key === "timeout-ms") {
    current.timeoutMs = Number(value);
  } else if (key === "provider") {
    current.provider = String(value) as PersistedConfig["provider"];
  } else if (key === "local-backend") {
    current.localBackend = String(value) as PersistedConfig["localBackend"];
  } else if (key === "local-concurrency") {
    current.localConcurrency = Number(value);
  } else if (key === "local-host") {
    current.localHost = String(value);
  } else if (key === "local-port") {
    current.localPort = Number(value);
  } else if (key === "dataset-enabled") {
    current.datasetEnabled = Boolean(value);
  } else if (key === "dataset-path") {
    current.datasetPath = String(value);
  } else if (key === "auto-learn") {
    current.autoLearn = Boolean(value);
  } else if (key === "auto-promote-scopes") {
    current.autoPromoteScopes = Boolean(value);
  } else if (key === "max-prompt-dsl-entries") {
    current.maxPromptDslEntries = Number(value);
  } else if (key === "host") {
    current.host = String(value);
  } else if (key === "api-key") {
    current.apiKey = String(value);
  } else {
    current.model = String(value);
  }

  await writePersistedConfig(env, current);
  return current;
}

export function getPersistedConfigValue(
  config: PersistedConfig,
  key: ConfigKey
): string | number | undefined {
  if (key === "timeout-ms") {
    return config.timeoutMs;
  }

  if (key === "provider") {
    return config.provider;
  }

  if (key === "local-backend") {
    return config.localBackend;
  }

  if (key === "local-concurrency") {
    return config.localConcurrency;
  }

  if (key === "local-host") {
    return config.localHost;
  }

  if (key === "local-port") {
    return config.localPort;
  }

  if (key === "dataset-enabled") {
    return config.datasetEnabled === undefined
      ? undefined
      : String(config.datasetEnabled);
  }

  if (key === "dataset-path") {
    return config.datasetPath;
  }

  if (key === "auto-learn") {
    return config.autoLearn === undefined ? undefined : String(config.autoLearn);
  }

  if (key === "auto-promote-scopes") {
    return config.autoPromoteScopes === undefined
      ? undefined
      : String(config.autoPromoteScopes);
  }

  if (key === "max-prompt-dsl-entries") {
    return config.maxPromptDslEntries;
  }

  if (key === "host") {
    return config.host;
  }

  if (key === "api-key") {
    return config.apiKey;
  }

  return config.model;
}

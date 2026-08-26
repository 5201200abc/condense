import { describe, expect, it } from "bun:test";

import type { RuntimeConfig } from "../src/config";
import {
  buildLocalServerArgs,
  ensureLocalServer,
  resolveLocalBackend
} from "../src/local-server";

function localConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    question: "Summarize",
    provider: "local",
    localBackend: "auto",
    localConcurrency: 5,
    localHost: "127.0.0.1",
    localPort: 8009,
    model: "samuelfaj/distill2-0.6B-4bit-MLX",
    host: "http://127.0.0.1:8009/v1",
    apiKey: "",
    timeoutMs: 90_000,
    datasetEnabled: false,
    ...overrides
  };
}

describe("local server backend selection", () => {
  it("uses MLX on Apple Silicon and llama.cpp elsewhere by default", () => {
    expect(resolveLocalBackend("auto", "darwin", "arm64")).toBe("mlx");
    expect(resolveLocalBackend("auto", "darwin", "x64")).toBe("llamacpp");
    expect(resolveLocalBackend("auto", "linux", "x64")).toBe("llamacpp");
    expect(resolveLocalBackend("auto", "win32", "x64")).toBe("llamacpp");
    expect(resolveLocalBackend("llamacpp", "darwin", "arm64")).toBe("llamacpp");
  });

  it("builds MLX server args for mlx_lm.server", () => {
    expect(buildLocalServerArgs("mlx", localConfig())).toEqual([
      "--model",
      "samuelfaj/distill2-0.6B-4bit-MLX",
      "--host",
      "127.0.0.1",
      "--port",
      "8009",
      "--prompt-cache-size",
      "0",
      "--prompt-cache-bytes",
      "0"
    ]);
  });

  it("builds llama.cpp server args with parallel slots and continuous batching", () => {
    expect(buildLocalServerArgs("llamacpp", localConfig())).toEqual([
      "--hf-repo",
      "samuelfaj/distill2-0.6B-4bit-GGUF:Q4_K_M",
      "--hf-file",
      "distill2-0.6B-Q4_K_M.GGUF",
      "--host",
      "127.0.0.1",
      "--port",
      "8009",
      "--parallel",
      "5",
      "--cont-batching",
      "--alias",
      "condense-local"
    ]);
  });
});

describe("ensureLocalServer", () => {
  it("reuses an already compatible local server instead of spawning another one", async () => {
    const events: string[] = [];

    await ensureLocalServer(localConfig(), {
      platform: "darwin",
      arch: "arm64",
      probeServer: async () => {
        events.push("probe");
        return { status: "ready" };
      },
      installRuntime: async () => {
        events.push("install");
        return "/tmp/mlx_lm.server";
      },
      spawnServer: async () => {
        events.push("spawn");
      }
    });

    expect(events).toEqual(["probe"]);
  });

  it("installs and starts the backend when no compatible server is running", async () => {
    const events: string[] = [];
    let probeCount = 0;

    await ensureLocalServer(localConfig({ localBackend: "llamacpp" }), {
      platform: "linux",
      arch: "x64",
      probeServer: async () => {
        probeCount += 1;
        events.push(`probe-${probeCount}`);
        return probeCount < 3 ? { status: "down" } : { status: "ready" };
      },
      installRuntime: async (backend) => {
        events.push(`install-${backend}`);
        return "/tmp/llama-server";
      },
      spawnServer: async (runtimePath, args) => {
        events.push(`spawn-${runtimePath}`);
        expect(args).toContain("--parallel");
        expect(args).toContain("5");
      }
    });

    expect(events).toEqual([
      "probe-1",
      "probe-2",
      "install-llamacpp",
      "spawn-/tmp/llama-server",
      "probe-3"
    ]);
  });

  it("fails loud when the configured local port belongs to another service", async () => {
    await expect(
      ensureLocalServer(localConfig(), {
        platform: "darwin",
        arch: "arm64",
        probeServer: async () => ({ status: "incompatible" }),
        installRuntime: async () => "/tmp/mlx_lm.server",
        spawnServer: async () => undefined
      })
    ).rejects.toThrow("127.0.0.1:8009");
  });
});

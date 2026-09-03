import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RuntimeConfig } from "../src/config";
import {
  buildLocalServerArgs,
  ensureLocalServer,
  killLocalServer,
  probeLocalServer,
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
      "--decode-concurrency",
      "5",
      "--prompt-concurrency",
      "5",
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

  it("kills zombie server and restarts when probe detects zombie status", async () => {
    const events: string[] = [];
    let probeCount = 0;

    await ensureLocalServer(localConfig(), {
      platform: "darwin",
      arch: "arm64",
      probeServer: async () => {
        probeCount += 1;
        events.push(`probe-${probeCount}`);
        return probeCount <= 2 ? { status: "zombie" } : { status: "ready" };
      },
      killServer: async () => {
        events.push("kill");
        return true;
      },
      installRuntime: async (backend) => {
        events.push(`install-${backend}`);
        return "/tmp/mlx_lm.server";
      },
      spawnServer: async (runtimePath) => {
        events.push(`spawn-${runtimePath}`);
      }
    });

    expect(events).toEqual([
      "probe-1",
      "probe-2",
      "kill",
      "install-mlx",
      "spawn-/tmp/mlx_lm.server",
      "probe-3"
    ]);
  });

  it("does not kill a server after one transient zombie probe", async () => {
    const events: string[] = [];
    let probeCount = 0;

    await ensureLocalServer(localConfig(), {
      probeServer: async () => {
        probeCount += 1;
        events.push(`probe-${probeCount}`);
        return probeCount === 1 ? { status: "zombie" } : { status: "ready" };
      },
      killServer: async () => {
        events.push("kill");
        return true;
      }
    });

    expect(events).toEqual(["probe-1", "probe-2"]);
  });
});

describe("probeLocalServer deep health check", () => {
  it("returns ready when both models endpoint and chat completions return 200", async () => {
    const config = localConfig();
    const result = await probeLocalServer(config, async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "model-1" }] }), { status: 200 });
      }
      if (urlStr.includes("/v1/chat/completions")) {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    expect(result.status).toBe("ready");
  });

  it("returns zombie when models endpoint is 200 but chat completions fails with 500 or crash", async () => {
    const config = localConfig();
    const result = await probeLocalServer(config, async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "model-1" }] }), { status: 200 });
      }
      if (urlStr.includes("/v1/chat/completions")) {
        return new Response("Internal Server Error: thread died", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    });

    expect(result.status).toBe("zombie");
  });

  it("returns down when connection fails entirely", async () => {
    const config = localConfig();
    const result = await probeLocalServer(config, async () => {
      throw new Error("Connection refused");
    });

    expect(result.status).toBe("down");
  });
});

describe("killLocalServer", () => {
  it("cleans up dead PID file safely", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "condense-kill-test-"));
    const configPath = path.join(dir, "config.json");
    const pidPath = path.join(dir, "logs", "local-server.pid");
    const env = { CONDENSE_CONFIG_PATH: configPath };

    try {
      await mkdir(path.dirname(pidPath), { recursive: true });
      await writeFile(pidPath, "99999999\n");
      const result = await killLocalServer(env);
      expect(result).toBe(true);
      await expect(readFile(pidPath, "utf8")).rejects.toThrow();

      const secondResult = await killLocalServer(env);
      expect(secondResult).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

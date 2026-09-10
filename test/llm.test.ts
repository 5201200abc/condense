import { describe, expect, it } from "bun:test";

import {
  chatCompletion,
  summarizeBatch,
  summarizeTranslate,
  summarizeWatch
} from "../src/llm";
import type { RuntimeConfig } from "../src/config";

const baseConfig: RuntimeConfig = {
  question: "Did tests pass? Return PASS or FAIL.",
  provider: "external",
  localBackend: "auto",
  localConcurrency: 5,
  localHost: "127.0.0.1",
  localPort: 8009,
  model: "qwen3.5:2b",
  host: "http://127.0.0.1:11434/v1",
  apiKey: "",
  timeoutMs: 100,
  datasetEnabled: false
};

describe("chatCompletion", () => {
  it("preserves nested base paths", async () => {
    let requestUrl = "";

    const output = await chatCompletion({
      baseUrl: "http://127.0.0.1:12434/engines/v1",
      apiKey: "not-needed",
      model: "ai/llama3.2",
      prompt: "hi",
      timeoutMs: 100,
      fetchImpl: async (input) => {
        requestUrl = String(input);

        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "  concise  " } }]
          }),
          { status: 200 }
        );
      }
    });

    expect(requestUrl).toBe("http://127.0.0.1:12434/engines/v1/chat/completions");
    expect(output).toBe("concise");
  });

  it("adds /v1 when the base URL does not include an API prefix", async () => {
    let requestUrl = "";

    await chatCompletion({
      baseUrl: "http://127.0.0.1:8000",
      apiKey: "",
      model: "qwen",
      prompt: "hi",
      timeoutMs: 100,
      fetchImpl: async (input) => {
        requestUrl = String(input);

        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }]
          }),
          { status: 200 }
        );
      }
    });

    expect(requestUrl).toBe("http://127.0.0.1:8000/v1/chat/completions");
  });

  it("throws when the provider returns a non-2xx status", async () => {
    await expect(
      chatCompletion({
        baseUrl: "http://127.0.0.1:8000",
        apiKey: "",
        model: "qwen",
        prompt: "hi",
        timeoutMs: 100,
        fetchImpl: async () => new Response("boom", { status: 500 })
      })
    ).rejects.toThrow("Request failed with 500.");
  });

  it("throws when the provider returns invalid JSON", async () => {
    await expect(
      chatCompletion({
        baseUrl: "http://127.0.0.1:8000",
        apiKey: "",
        model: "qwen",
        prompt: "hi",
        timeoutMs: 100,
        fetchImpl: async () => new Response("not-json", { status: 200 })
      })
    ).rejects.toThrow("Provider returned invalid JSON.");
  });

  it("throws when the response payload is missing choices", async () => {
    await expect(
      chatCompletion({
        baseUrl: "http://127.0.0.1:8000",
        apiKey: "",
        model: "qwen",
        prompt: "hi",
        timeoutMs: 100,
        fetchImpl: async () =>
          new Response(JSON.stringify({ choices: [] }), { status: 200 })
      })
    ).rejects.toThrow("Provider returned an invalid response payload.");

    await expect(
      chatCompletion({
        baseUrl: "http://127.0.0.1:8000",
        apiKey: "",
        model: "qwen",
        prompt: "hi",
        timeoutMs: 100,
        fetchImpl: async () =>
          new Response(JSON.stringify({}), { status: 200 })
      })
    ).rejects.toThrow("Provider returned an invalid response payload.");
  });

  it("throws when content is empty or whitespace-only", async () => {
    await expect(
      chatCompletion({
        baseUrl: "http://127.0.0.1:8000",
        apiKey: "",
        model: "qwen",
        prompt: "hi",
        timeoutMs: 100,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "   " } }]
            }),
            { status: 200 }
          )
      })
    ).rejects.toThrow("Provider returned an empty response.");
  });
});

describe("summarizeBatch", () => {
  it("starts the local server before sending local-provider requests", async () => {
    const events: string[] = [];

    const output = await summarizeBatch(
      {
        ...baseConfig,
        provider: "local",
        model: "condense-local",
        host: "http://127.0.0.1:8009/v1"
      },
      "1 passed",
      {
        ensureLocalServer: async (config) => {
          events.push(`${config.provider}:${config.localBackend}`);
        }
      },
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "PASS" } }]
          }),
          { status: 200 }
        )
    );

    expect(output).toBe("PASS");
    expect(events).toEqual(["local:auto"]);
  });

  it("does not start the local server for explicitly external requests", async () => {
    const events: string[] = [];

    await summarizeBatch(
      baseConfig,
      "1 passed",
      {
        ensureLocalServer: async () => {
          events.push("unexpected");
        }
      },
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "PASS" } }]
          }),
          { status: 200 }
        )
    );

    expect(events).toEqual([]);
  });

  it("limits concurrent local-provider HTTP requests to local-concurrency", async () => {
    let activeRequests = 0;
    let maxActiveRequests = 0;

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        summarizeBatch(
          {
            ...baseConfig,
            provider: "local",
            localConcurrency: 2,
            host: "http://127.0.0.1:8009/v1"
          },
          `input ${index}`,
          {
            ensureLocalServer: async () => undefined
          },
          async () => {
            activeRequests += 1;
            maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
            await new Promise((resolve) => setTimeout(resolve, 5));
            activeRequests -= 1;

            return new Response(
              JSON.stringify({
                choices: [{ message: { content: "PASS" } }]
              }),
              { status: 200 }
            );
          }
        )
      )
    );

    expect(maxActiveRequests).toBe(2);
  });

  it("restarts the local server and retries one failed request", async () => {
    const events: string[] = [];
    let requests = 0;

    const output = await summarizeBatch(
      {
        ...baseConfig,
        provider: "local",
        host: "http://127.0.0.1:8009/v1"
      },
      "1 passed",
      {
        ensureLocalServer: async () => {
          events.push("ensure");
        },
        killLocalServer: async () => {
          events.push("kill");
          return true;
        }
      },
      async () => {
        requests += 1;

        if (requests === 1) {
          return new Response("oom", { status: 500 });
        }

        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "PASS" } }]
          }),
          { status: 200 }
        );
      }
    );

    expect(output).toBe("PASS");
    expect(requests).toBe(2);
    expect(events).toEqual(["ensure", "kill", "ensure"]);
  });

  it("caps local batch input while retaining the larger external budget", async () => {
    const input = "x".repeat(12_000);
    const bodies: Array<{
      messages: Array<{ role: string; content: string }>;
    }> = [];
    const fetchImpl = async (_: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "PASS" } }]
        }),
        { status: 200 }
      );
    };

    await summarizeBatch(
      {
        ...baseConfig,
        provider: "local",
        host: "http://127.0.0.1:8009/v1"
      },
      input,
      { ensureLocalServer: async () => undefined },
      fetchImpl
    );
    await summarizeBatch(baseConfig, input, fetchImpl);

    expect(bodies[0].messages[1].content).toContain("chars truncated");
    expect(bodies[1].messages[1].content).not.toContain("chars truncated");
  });

  it("sends the batch prompt with config-derived params", async () => {
    let requestBody: unknown;

    const output = await summarizeBatch(
      baseConfig,
      "1 passed",
      async (_, init) => {
        requestBody = JSON.parse(String(init?.body ?? "{}"));

        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "PASS" } }]
          }),
          { status: 200 }
        );
      }
    );

    expect(output).toBe("PASS");
    const body = requestBody as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      temperature: number;
      max_tokens: number;
    };
    expect(body.model).toBe("qwen3.5:2b");
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(512);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toContain("1 passed");
    expect(body.messages[1].content).toContain(baseConfig.question);
  });

  it("uses the compact training system prompt without runtime few-shot", async () => {
    let requestBody: unknown;

    const output = await summarizeBatch(
      baseConfig,
      "cache warmed\ncache reused\nmodel loaded\nmodel reused",
      async (_, init) => {
        requestBody = JSON.parse(String(init?.body ?? "{}"));

        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "S cache=#c1 model=#m1\nO #c1 + #m1 reused" } }]
          }),
          { status: 200 }
        );
      }
    );

    const body = requestBody as {
      messages: Array<{ role: string; content: string }>;
    };

    expect(output).toContain("#c1");
    expect(body.messages[0].content).toContain("output only NONE");
    expect(body.messages[0].content).not.toContain("Examples:");
    expect(body.messages[0].content).not.toContain("Inline variable rule");
    expect(body.messages[0].content).not.toContain("worker-xy");
    expect(body.messages[0].content).not.toContain("Known /condense DSL memory");
    expect(body.messages[0].content).not.toContain("workspace=#w3");
  });

  it("injects compact DSL memory into the batch system prompt", async () => {
    let requestBody: unknown;

    const output = await summarizeBatch(
      baseConfig,
      "auth failed",
      { dslMemory: "AUTH = authentication fix (alias, project)" },
      async (_, init) => {
        requestBody = JSON.parse(String(init?.body ?? "{}"));

        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "AUTH fixed" } }]
          }),
          { status: 200 }
        );
      }
    );

    const body = requestBody as {
      messages: Array<{ role: string; content: string }>;
    };

    expect(output).toBe("AUTH fixed");
    expect(body.messages[0].content).not.toContain("Known /condense DSL memory");
    expect(body.messages[1].content).toContain("Known /condense DSL memory");
    expect(body.messages[1].content).toContain(
      "AUTH = authentication fix (alias, project)"
    );
    expect(body.messages[0].content).toContain("output only NONE");
    expect(body.messages[0].content).not.toContain("Examples:");
    expect(body.messages[0].content).not.toContain("Inline variable rule");
    expect(body.messages[0].content).not.toContain("workspace=#w3");
    expect(body.messages[1].content).toContain("Emit Dict+ only");
  });

  it("keeps the batch system prompt stable and enables llama.cpp prompt cache locally", async () => {
    const bodies: Array<{
      cache_prompt?: boolean;
      chat_template_kwargs?: { enable_thinking: boolean };
      messages: Array<{ role: string; content: string }>;
    }> = [];
    const fetchImpl = async (_: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "PASS" } }]
        }),
        { status: 200 }
      );
    };

    await summarizeBatch(baseConfig, "1 passed", fetchImpl);
    await summarizeBatch(
      {
        ...baseConfig,
        provider: "local",
        host: "http://127.0.0.1:8009/v1"
      },
      "2 passed",
      { dslMemory: "A = auth fix (alias, project)", ensureLocalServer: async () => undefined },
      fetchImpl
    );

    expect(bodies[0].cache_prompt).toBeUndefined();
    expect(bodies[1].cache_prompt).toBe(true);
    expect(bodies[0].chat_template_kwargs).toBeUndefined();
    expect(bodies[1].chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(bodies[0].messages[0].content).toBe(bodies[1].messages[0].content);
    expect(bodies[1].messages[1].content).toContain("Known /condense DSL memory");
    expect(bodies[1].messages[1].content).toContain("2 passed");
  });
});

describe("summarizeTranslate", () => {
  it("asks the provider to expand /condense Military English into human language", async () => {
    let systemContent = "";
    let userContent = "";

    const output = await summarizeTranslate(
      baseConfig,
      [
        "Dict: be=backend fe=frontend",
        "Best:",
        "Fix auth bug.",
        "Add failing test first.",
        "No fe change.",
        "Pass: valid user allowed, tests pass.",
        "More aggressive:",
        "Fix be auth only.",
        "Tradeoff:",
        "Less context for reviewer."
      ].join("\n"),
      "en-US",
      async (_, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          messages: Array<{ role: string; content: string }>;
        };
        systemContent = body.messages[0].content;
        userContent = body.messages[1].content;

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "Done because tests passed. Next step: ship it."
                }
              }
            ]
          }),
          { status: 200 }
        );
      }
    );

    expect(output).toBe("Done because tests passed. Next step: ship it.");
    expect(systemContent).toContain("Military English");
    expect(systemContent).toContain("Best");
    expect(systemContent).toContain("Dict");
    expect(systemContent).toContain("Pass");
    expect(userContent).toContain("Dict: be=backend fe=frontend");
    expect(userContent).toContain("No fe change.");
    expect(userContent).toContain("en-US");
  });
});

describe("summarizeWatch", () => {
  it("sends both cycles in the watch prompt", async () => {
    let userContent = "";

    await summarizeWatch(
      baseConfig,
      "failed: 0",
      "failed: 1",
      async (_, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          messages: Array<{ role: string; content: string }>;
        };
        userContent = body.messages[1].content;

        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "failure count rose" } }]
          }),
          { status: 200 }
        );
      }
    );

    expect(userContent).toContain("failed: 0");
    expect(userContent).toContain("failed: 1");
  });
});

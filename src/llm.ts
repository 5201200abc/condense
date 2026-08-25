import type { RuntimeConfig } from "./config";
import { ensureLocalServer } from "./local-server";
import {
  buildBatchPrompt,
  buildDslPromotionPrompt,
  buildThreadLearnPrompt,
  buildTranslatePrompt,
  buildWatchPrompt,
  type PromptMessages
} from "./prompt";

export interface ChatCompletionRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string | PromptMessages;
  timeoutMs: number;
  maxTokens?: number;
  temperature?: number;
  fetchImpl?: typeof fetch;
}

interface SummarizeOptions {
  dslMemory?: string;
  ensureLocalServer?: (config: RuntimeConfig) => Promise<void>;
}

interface LocalRequestGate {
  active: number;
  queue: Array<() => void>;
}

const localRequestGates = new Map<string, LocalRequestGate>();

function buildChatCompletionsUrl(baseUrl: string): URL {
  const normalized = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const pathname = normalized.pathname.replace(/\/+$/, "");

  normalized.pathname =
    pathname === "" || pathname === "/"
      ? "/v1/chat/completions"
      : `${pathname}/chat/completions`;
  normalized.search = "";
  normalized.hash = "";

  return normalized;
}

async function withLocalRequestGate<T>(
  config: RuntimeConfig,
  callback: () => Promise<T>
): Promise<T> {
  const key = `${config.localHost}:${config.localPort}`;
  let gate = localRequestGates.get(key);

  if (!gate) {
    gate = { active: 0, queue: [] };
    localRequestGates.set(key, gate);
  }

  await acquireLocalRequestSlot(gate, config.localConcurrency);

  try {
    return await callback();
  } finally {
    releaseLocalRequestSlot(key, gate);
  }
}

function acquireLocalRequestSlot(
  gate: LocalRequestGate,
  limit: number
): Promise<void> {
  if (gate.active < limit) {
    gate.active += 1;
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    gate.queue.push(() => {
      gate.active += 1;
      resolve();
    });
  });
}

function releaseLocalRequestSlot(key: string, gate: LocalRequestGate): void {
  gate.active -= 1;

  const next = gate.queue.shift();

  if (next) {
    next();
    return;
  }

  if (gate.active === 0) {
    localRequestGates.delete(key);
  }
}

export async function chatCompletion({
  baseUrl,
  apiKey,
  model,
  prompt,
  timeoutMs,
  maxTokens,
  temperature,
  fetchImpl = fetch
}: ChatCompletionRequest): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = buildChatCompletionsUrl(baseUrl);
    const messages =
      typeof prompt === "string"
        ? [{ role: "user", content: prompt }]
        : [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user }
          ];
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: temperature ?? 0,
        ...(maxTokens ? { max_tokens: maxTokens } : {})
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}.`);
    }

    const rawText = await response.text();
    let payload: unknown;

    try {
      payload = JSON.parse(rawText);
    } catch {
      throw new Error("Provider returned invalid JSON.");
    }

    if (
      typeof payload !== "object" ||
      payload === null ||
      !Array.isArray((payload as { choices?: unknown }).choices) ||
      (payload as { choices: unknown[] }).choices.length === 0
    ) {
      throw new Error("Provider returned an invalid response payload.");
    }

    const choice = (payload as {
      choices: Array<{ message?: { content?: string } }>;
    }).choices[0];
    const content = choice?.message?.content?.trim();

    if (!content) {
      throw new Error("Provider returned an empty response.");
    }

    return content;
  } finally {
    clearTimeout(timeout);
  }
}

async function summarize(
  config: RuntimeConfig,
  prompt: PromptMessages,
  fetchImpl?: typeof fetch,
  ensureLocalServerImpl: (config: RuntimeConfig) => Promise<void> = ensureLocalServer
): Promise<string> {
  if (config.provider === "local") {
    await ensureLocalServerImpl(config);
  }

  const request = () =>
    chatCompletion({
      baseUrl: config.host,
      apiKey: config.apiKey,
      model: config.model,
      prompt,
      timeoutMs: config.timeoutMs,
      temperature: 0,
      maxTokens: 512,
      fetchImpl
    });

  return config.provider === "local"
    ? withLocalRequestGate(config, request)
    : request();
}

export function summarizeBatch(
  config: RuntimeConfig,
  input: string,
  optionsOrFetchImpl: SummarizeOptions | typeof fetch = {},
  fetchImpl?: typeof fetch
): Promise<string> {
  const options =
    typeof optionsOrFetchImpl === "function" ? {} : optionsOrFetchImpl;
  const resolvedFetchImpl =
    typeof optionsOrFetchImpl === "function" ? optionsOrFetchImpl : fetchImpl;

  return summarize(
    config,
    buildBatchPrompt(config.question, input, options),
    resolvedFetchImpl,
    options.ensureLocalServer
  );
}

export function summarizeTranslate(
  config: RuntimeConfig,
  text: string,
  language: string,
  fetchImpl?: typeof fetch
): Promise<string> {
  return summarize(config, buildTranslatePrompt(text, language), fetchImpl);
}

export function summarizeWatch(
  config: RuntimeConfig,
  previousCycle: string,
  currentCycle: string,
  fetchImpl?: typeof fetch
): Promise<string> {
  return summarize(
    config,
    buildWatchPrompt(config.question, previousCycle, currentCycle),
    fetchImpl
  );
}

export function summarizeDslPromotion(
  config: RuntimeConfig,
  entries: string,
  fetchImpl?: typeof fetch
): Promise<string> {
  return summarize(config, buildDslPromotionPrompt(entries), fetchImpl);
}

export function summarizeThreadLearn(
  config: RuntimeConfig,
  transcript: string,
  candidates: Parameters<typeof buildThreadLearnPrompt>[1],
  dslMemory: string,
  fetchImpl?: typeof fetch
): Promise<string> {
  return summarize(
    config,
    buildThreadLearnPrompt(transcript, candidates, dslMemory),
    fetchImpl
  );
}

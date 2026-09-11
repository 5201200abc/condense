import type { RuntimeConfig } from "./config";
import { ensureLocalServer, killLocalServer } from "./local-server";
import {
  buildBatchPrompt,
  buildDslPromotionPrompt,
  buildThreadLearnPrompt,
  buildTranslatePrompt,
  buildWatchPrompt,
  LOCAL_MAX_INPUT_CHARS,
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
  cachePrompt?: boolean;
  chatTemplateKwargs?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}

export interface CompletionTimings {
  promptMs: number;
  predictedMs: number;
  promptN: number;
  predictedN: number;
  cacheN: number;
  cacheSavedMs: number;
}

export interface ChatCompletionResult {
  content: string;
  timings?: CompletionTimings;
}

export function estimateCacheSavedMs(
  cacheN: number,
  promptN: number,
  promptMs: number
): number {
  if (cacheN <= 0 || promptN <= 0 || promptMs <= 0) {
    return 0;
  }
  // Tiny prompt_n is mostly kernel overhead, so tok/s is not a real prefill rate.
  if (promptN < 24) {
    return 0;
  }
  return Math.round((cacheN / promptN) * promptMs);
}

export function parseCompletionTimings(payload: unknown): CompletionTimings | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const timings = (payload as { timings?: Record<string, unknown> }).timings;
  if (!timings || typeof timings !== "object") {
    return undefined;
  }
  const promptN = Number(timings.prompt_n ?? 0);
  const predictedN = Number(timings.predicted_n ?? 0);
  const cacheN = Number(timings.cache_n ?? 0);
  const promptMs = Number(timings.prompt_ms ?? 0);
  const predictedMs = Number(timings.predicted_ms ?? 0);
  if (
    ![promptN, predictedN, cacheN, promptMs, predictedMs].some(
      (value) => Number.isFinite(value) && value > 0
    )
  ) {
    return undefined;
  }
  const cacheSavedMs = estimateCacheSavedMs(cacheN, promptN, promptMs);
  return {
    promptMs: Number.isFinite(promptMs) ? promptMs : 0,
    predictedMs: Number.isFinite(predictedMs) ? predictedMs : 0,
    promptN: Number.isFinite(promptN) ? promptN : 0,
    predictedN: Number.isFinite(predictedN) ? predictedN : 0,
    cacheN: Number.isFinite(cacheN) ? cacheN : 0,
    cacheSavedMs
  };
}

interface SummarizeOptions {
  dslMemory?: string;
  ensureLocalServer?: (config: RuntimeConfig) => Promise<void>;
  killLocalServer?: (env: NodeJS.ProcessEnv) => Promise<boolean>;
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

export async function chatCompletion(
  request: ChatCompletionRequest
): Promise<string> {
  return (await chatCompletionDetailed(request)).content;
}

export async function chatCompletionDetailed({
  baseUrl,
  apiKey,
  model,
  prompt,
  timeoutMs,
  maxTokens,
  temperature,
  cachePrompt,
  chatTemplateKwargs,
  fetchImpl = fetch
}: ChatCompletionRequest): Promise<ChatCompletionResult> {
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
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        ...(cachePrompt ? { cache_prompt: true } : {}),
        ...(chatTemplateKwargs ? { chat_template_kwargs: chatTemplateKwargs } : {})
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

    return { content, timings: parseCompletionTimings(payload) };
  } finally {
    clearTimeout(timeout);
  }
}

async function summarize(
  config: RuntimeConfig,
  prompt: PromptMessages,
  fetchImpl?: typeof fetch,
  ensureLocalServerImpl: (config: RuntimeConfig) => Promise<void> = ensureLocalServer,
  killLocalServerImpl: (env: NodeJS.ProcessEnv) => Promise<boolean> = killLocalServer
): Promise<ChatCompletionResult> {
  if (config.provider === "local") {
    await ensureLocalServerImpl(config);
  }

  const request = () =>
    chatCompletionDetailed({
      baseUrl: config.host,
      apiKey: config.apiKey,
      model: config.model,
      prompt,
      timeoutMs: config.timeoutMs,
      temperature: 0,
      maxTokens: 512,
      cachePrompt: config.provider === "local",
      chatTemplateKwargs: config.provider === "local" ? { enable_thinking: false } : undefined,
      fetchImpl
    });

  if (config.provider !== "local") {
    return request();
  }

  return withLocalRequestGate(config, async () => {
    try {
      return await request();
    } catch {
      await killLocalServerImpl(process.env).catch(() => {});
      await ensureLocalServerImpl(config);
    }

    try {
      return await request();
    } catch (error) {
      await killLocalServerImpl(process.env).catch(() => {});
      throw error;
    }
  });
}

export async function summarizeBatch(
  config: RuntimeConfig,
  input: string,
  optionsOrFetchImpl: SummarizeOptions | typeof fetch = {},
  fetchImpl?: typeof fetch
): Promise<string> {
  return (await summarizeBatchDetailed(config, input, optionsOrFetchImpl, fetchImpl))
    .content;
}

export async function summarizeBatchDetailed(
  config: RuntimeConfig,
  input: string,
  optionsOrFetchImpl: SummarizeOptions | typeof fetch = {},
  fetchImpl?: typeof fetch
): Promise<ChatCompletionResult> {
  const options =
    typeof optionsOrFetchImpl === "function" ? {} : optionsOrFetchImpl;
  const resolvedFetchImpl =
    typeof optionsOrFetchImpl === "function" ? optionsOrFetchImpl : fetchImpl;
  const promptOptions = {
    ...options,
    maxInputChars:
      config.provider === "local"
        ? Math.min(options.maxInputChars ?? LOCAL_MAX_INPUT_CHARS, LOCAL_MAX_INPUT_CHARS)
        : options.maxInputChars
  };

  return summarize(
    config,
    buildBatchPrompt(config.question, input, promptOptions),
    resolvedFetchImpl,
    options.ensureLocalServer,
    options.killLocalServer
  );
}

export async function summarizeTranslate(
  config: RuntimeConfig,
  text: string,
  language: string,
  fetchImpl?: typeof fetch
): Promise<string> {
  return (await summarize(config, buildTranslatePrompt(text, language), fetchImpl))
    .content;
}

export async function summarizeWatch(
  config: RuntimeConfig,
  previousCycle: string,
  currentCycle: string,
  fetchImpl?: typeof fetch
): Promise<string> {
  return (
    await summarize(
      config,
      buildWatchPrompt(
        config.question,
        previousCycle,
        currentCycle,
        config.provider === "local" ? LOCAL_MAX_INPUT_CHARS / 2 : undefined
      ),
      fetchImpl
    )
  ).content;
}

export async function summarizeDslPromotion(
  config: RuntimeConfig,
  entries: string,
  fetchImpl?: typeof fetch
): Promise<string> {
  return (await summarize(config, buildDslPromotionPrompt(entries), fetchImpl)).content;
}

export async function summarizeThreadLearn(
  config: RuntimeConfig,
  transcript: string,
  candidates: Parameters<typeof buildThreadLearnPrompt>[1],
  dslMemory: string,
  fetchImpl?: typeof fetch
): Promise<string> {
  return (
    await summarize(
      config,
      buildThreadLearnPrompt(transcript, candidates, dslMemory),
      fetchImpl
    )
  ).content;
}

import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { isLongLog, isOverflowRisk } from "./policy";
import { estimateTokens } from "./stats";
import { resolveConfigPath } from "./user-config";

export type ObserveKind = "long" | "overflow" | "suspect";

export const OBSERVE_INPUT_CHARS = 16_000;

export interface ObserveRecord {
  requestId: string;
  timestamp: string;
  kinds: ObserveKind[];
  suspectReasons: string[];
  question: string;
  inputChars: number;
  inputLines: number;
  outputChars: number;
  rawEstimatedTokens: number;
  outputEstimatedTokens: number;
  output: string;
  client: string;
  model: string;
  contextWindowTokens?: number;
  latencyMs: number;
  projectPath?: string;
}

export function resolveObservePath(env: NodeJS.ProcessEnv): string {
  const explicit = env.CONDENSE_OBSERVE_PATH?.trim();
  if (explicit) {
    return explicit;
  }
  return path.join(path.dirname(resolveConfigPath(env)), "observe.jsonl");
}

export function normalizeClientName(name?: string): string {
  if (!name || typeof name !== "string") {
    return "Unknown";
  }
  const cleaned = name.trim();
  const lower = cleaned.toLowerCase().replace(/[-_\s]+/g, "");
  if (lower === "codex") {
    return "Codex";
  }
  if (lower === "claudecode" || lower === "claude") {
    return "Claude Code";
  }
  if (lower === "cursor") {
    return "Cursor";
  }
  if (lower === "aider") {
    return "Aider";
  }
  if (lower === "unknown") {
    return "Unknown";
  }
  return cleaned;
}

export function matchesClient(recordClient?: string, queryClient?: string): boolean {
  if (!queryClient) {
    return true;
  }
  const normQuery = normalizeClientName(queryClient).toLowerCase();
  const normRecord = normalizeClientName(recordClient).toLowerCase();
  return normRecord === normQuery || normRecord.includes(normQuery);
}

export function detectClient(env: NodeJS.ProcessEnv): string {
  const explicit = env.CONDENSE_CLIENT?.trim();
  if (explicit) {
    return normalizeClientName(explicit);
  }
  if (env.CODEX_SESSION_ID || env.CODEX_CLI || env.CODEX_THREAD_ID) {
    return "Codex";
  }
  if (env.CLAUDE_CODE || env.CLAUDE_PROJECT_DIR || env.CLAUDE_SESSION_ID) {
    return "Claude Code";
  }
  if (env.CURSOR_AGENT || env.CURSOR_TRACE_ID || env.CURSOR_PROJECT_DIR) {
    return "Cursor";
  }
  if (env.AIDER_MODEL || env.AIDER_ANALYTICS) {
    return "Aider";
  }
  return "Unknown";
}

export function parseTokenCount(raw: string): number | undefined {
  const cleaned = raw.trim().toLowerCase();
  const match = cleaned.match(/^(\d+(?:\.\d+)?)\s*([km])?$/i);
  if (!match) {
    const direct = parseInt(cleaned, 10);
    return Number.isFinite(direct) && direct > 0 ? direct : undefined;
  }
  const num = parseFloat(match[1]);
  const unit = match[2]?.toLowerCase();
  if (unit === "k") {
    return Math.round(num * 1000);
  }
  if (unit === "m") {
    return Math.round(num * 1000000);
  }
  return Math.round(num);
}

export function detectContextWindowTokens(
  env: NodeJS.ProcessEnv,
  _client?: string
): number | undefined {
  const explicit = env.CONDENSE_CONTEXT_WINDOW?.trim();
  if (explicit) {
    const parsed = parseTokenCount(explicit);
    if (parsed) {
      return parsed;
    }
  }
  const codexWindow = env.CODEX_CONTEXT_WINDOW?.trim();
  if (codexWindow) {
    const parsed = parseTokenCount(codexWindow);
    if (parsed) {
      return parsed;
    }
  }
  const claudeWindow = env.CLAUDE_CONTEXT_WINDOW?.trim();
  if (claudeWindow) {
    const parsed = parseTokenCount(claudeWindow);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

export function formatWindowBucket(tokens?: number): string {
  if (tokens === undefined || tokens <= 0) {
    return "Unknown";
  }
  if (tokens >= 1_000_000) {
    const val = tokens / 1_000_000;
    return `${parseFloat(val.toFixed(1))}M`;
  }
  if (tokens >= 1_000) {
    const val = tokens / 1_000;
    return `${parseFloat(val.toFixed(1))}K`;
  }
  return tokens.toLocaleString();
}

function clipInput(text: string): string {
  if (text.length <= OBSERVE_INPUT_CHARS) {
    return text;
  }
  const keep = Math.floor(OBSERVE_INPUT_CHARS / 2) - 40;
  const dropped = text.length - 2 * keep;
  return `${text.slice(0, keep)}\n... [${dropped} chars omitted] ...\n${text.slice(-keep)}`;
}

export function detectSuspectReasons(
  rawInput: string,
  output: string,
  _question?: string
): string[] {
  const raw = rawInput;
  const out = output.trim();
  if (!out || out === raw) {
    return [];
  }

  const rawHasFail = /\bFAIL(?:ED)?\b/.test(raw);
  const rawHasPass = /\bPASS\b/.test(raw) || /\bpassed\b/i.test(raw);
  const outHasFail = /\bFAIL(?:ED)?\b/.test(out);
  const outIsPass = /^\s*PASS\b/i.test(out) && !outHasFail;
  const reasons: string[] = [];

  if (rawHasFail && rawHasPass && outIsPass) {
    reasons.push("mixed_pass_fail");
  } else if (rawHasFail && !outHasFail && /\bPASS\b/.test(out)) {
    reasons.push("missed_fail");
  }

  const destructive =
    /will be destroyed|must be replaced|# forces replacement|\bdestroy\s+\d+/i.test(
      raw
    );
  if (destructive && /^\s*SAFE\b/i.test(out)) {
    reasons.push("terraform_destructive");
  }

  const emptyish =
    /timed? out|no tests? ran|insufficient information|no (?:ci|test) result/i.test(
      raw
    ) && !rawHasFail;
  if (emptyish && /^\s*FAIL\b/i.test(out)) {
    reasons.push("empty_as_fail");
  }

  if (!reasons.includes("mixed_pass_fail") && !reasons.includes("missed_fail")) {
    const failNames = [...raw.matchAll(/\bFAIL\s+(\S+)/g)].map((match) => match[1]);
    const tsFiles = [
      ...raw.matchAll(/(\S+\.tsx?)\(\d+,\d+\):\s*error TS/g)
    ].map((match) => match[1]);
    const missed = [...failNames, ...tsFiles].filter(
      (token) => token && !out.includes(token)
    );
    if (missed.length > 0) {
      reasons.push("missed_critical");
    }
  }

  return reasons;
}

export interface BuildObserveRecordOptions {
  requestId: string;
  question: string;
  rawInput: string;
  modelInput?: string;
  output: string;
  inputLines: number;
  now?: Date;
  client?: string;
  model?: string;
  contextWindowTokens?: number;
  latencyMs?: number;
  projectPath?: string;
}

export function buildObserveRecord(options: BuildObserveRecordOptions): ObserveRecord {
  const suspectReasons = detectSuspectReasons(
    options.rawInput,
    options.output,
    options.question
  );
  const kinds: ObserveKind[] = [];
  if (isLongLog(options.rawInput.length, options.inputLines)) {
    kinds.push("long");
  }
  if (isOverflowRisk(options.rawInput.length)) {
    kinds.push("overflow");
  }
  if (suspectReasons.length > 0) {
    kinds.push("suspect");
  }

  return {
    requestId: options.requestId,
    timestamp: (options.now ?? new Date()).toISOString(),
    kinds,
    suspectReasons,
    question: options.question,
    inputChars: options.rawInput.length,
    inputLines: options.inputLines,
    outputChars: options.output.length,
    rawEstimatedTokens: estimateTokens(options.rawInput),
    outputEstimatedTokens: estimateTokens(options.output),
    output: options.output,
    client: options.client ?? "Unknown",
    model: options.model ?? "v2",
    contextWindowTokens: options.contextWindowTokens,
    latencyMs: options.latencyMs ?? 0,
    projectPath: options.projectPath
  };
}

export async function appendObserveRecord(
  env: NodeJS.ProcessEnv,
  record: ObserveRecord
): Promise<void> {
  const observePath = resolveObservePath(env);
  await mkdir(path.dirname(observePath), { recursive: true, mode: 0o700 });
  const handle = await open(observePath, "a", 0o600);
  try {
    await handle.appendFile(`${JSON.stringify(record)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

export async function readObserveRecords(
  env: NodeJS.ProcessEnv
): Promise<ObserveRecord[]> {
  const observePath = resolveObservePath(env);
  try {
    const raw = await readFile(observePath, "utf8");
    const records: ObserveRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const item = JSON.parse(trimmed) as Partial<ObserveRecord>;
        records.push({
          requestId: item.requestId ?? "00000000",
          timestamp: item.timestamp ?? new Date().toISOString(),
          kinds: item.kinds ?? [],
          suspectReasons: item.suspectReasons ?? [],
          question: item.question ?? "",
          inputChars: item.inputChars ?? 0,
          inputLines: item.inputLines ?? 0,
          outputChars: item.outputChars ?? 0,
          rawEstimatedTokens: item.rawEstimatedTokens ?? 0,
          outputEstimatedTokens: item.outputEstimatedTokens ?? 0,
          output: item.output ?? "",
          client: normalizeClientName(item.client),
          model: item.model ?? "v2",
          contextWindowTokens: item.contextWindowTokens,
          latencyMs: item.latencyMs ?? 0,
          projectPath: item.projectPath
        });
      } catch {
        // Skip malformed entries
      }
    }
    return records;
  } catch {
    return [];
  }
}

export async function clearObserveRecords(
  env: NodeJS.ProcessEnv
): Promise<void> {
  const observePath = resolveObservePath(env);
  try {
    await rm(observePath, { force: true });
  } catch {
    // Ignore missing
  }
}

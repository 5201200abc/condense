import { mkdir, open } from "node:fs/promises";
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
}

export function resolveObservePath(env: NodeJS.ProcessEnv): string {
  const explicit = env.CONDENSE_OBSERVE_PATH?.trim();
  if (explicit) {
    return explicit;
  }
  return path.join(path.dirname(resolveConfigPath(env)), "observe.jsonl");
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

export function buildObserveRecord(options: {
  requestId: string;
  question: string;
  rawInput: string;
  modelInput?: string;
  output: string;
  inputLines: number;
  now?: Date;
}): ObserveRecord | null {
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
  if (kinds.length === 0) {
    return null;
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
    output: options.output
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

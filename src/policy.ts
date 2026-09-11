export const SHORT_MAX_LINES = 100;
export const SHORT_MAX_CHARS = 4000;
export const LONG_LOG_LINES = 100;
export const LONG_LOG_CHARS = 8_000;
export const OVERFLOW_RISK_CHARS = 128_000;

export type CondenseSkipReason = "short" | "dense";

const DENSE_QUESTION =
  /通读|整仓|仓库文件|调用链|source responsibilities|codebase architecture|all (?:repo|repository) files|main control flow/i;

const TOOL_LOG =
  /\b(PASS|FAIL|FAILED|PANIC|ERROR TS\d+|error TS\d+|terraform |\bPlan: |\d+ passed|\d+ failed|ok \d+|will be destroyed|stack traceback|WARNING:)\b/i;

const CODE_LINE =
  /^\s*(import |export |from |package |func |fn |def |class |struct |impl |#include |using |public |private |protected |diff --git )/i;

export function countLines(text: string): number {
  if (!text) {
    return 0;
  }
  return text.split("\n").length;
}

export function looksLikeToolLog(text: string): boolean {
  return TOOL_LOG.test(text.slice(0, 12_000));
}

export function looksLikeSourceDump(text: string): boolean {
  if (looksLikeToolLog(text)) {
    return false;
  }
  if (/\bdiff --git /.test(text.slice(0, 12_000))) {
    return true;
  }
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 40) {
    return false;
  }
  let code = 0;
  const sample = lines.slice(0, 400);
  for (const line of sample) {
    if (CODE_LINE.test(line)) {
      code += 1;
    }
  }
  return code / sample.length >= 0.25;
}

export function looksLikeDenseQuestion(question: string | undefined): boolean {
  if (!question) {
    return false;
  }
  return DENSE_QUESTION.test(question);
}

export function condenseSkipReason(
  input: string,
  question?: string
): CondenseSkipReason | null {
  const lines = countLines(input);
  const chars = input.length;
  if (lines < SHORT_MAX_LINES && chars < SHORT_MAX_CHARS) {
    return "short";
  }
  if (looksLikeDenseQuestion(question) || looksLikeSourceDump(input)) {
    return "dense";
  }
  return null;
}

export function shouldCondense(input: string, question?: string): boolean {
  return condenseSkipReason(input, question) === null;
}

export function isLongLog(inputChars: number, inputLines: number): boolean {
  return inputLines >= LONG_LOG_LINES || inputChars >= LONG_LOG_CHARS;
}

export function isOverflowRisk(inputChars: number): boolean {
  return inputChars >= OVERFLOW_RISK_CHARS;
}

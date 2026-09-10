export interface PromptMessages {
  system: string;
  user: string;
}

export interface BatchPromptOptions {
  dslMemory?: string;
  maxInputChars?: number;
}

export interface ThreadLearnPromptCandidate {
  key: string;
  meaning: string;
  kind: "alias" | "macro" | "default";
  scope: "global" | "stack" | "project";
  occurrenceCount: number;
  source: string;
}

const SAFETY_EVALUATION_GUIDELINES = [
  "SAFETY ASSESSMENT CRITERIA:",
  "When tasked with evaluating operational risk or safety (e.g. SAFE / REVIEW / UNSAFE, PASS / FAIL policy checks), apply conservative evaluation:",
  "- Treat as UNSAFE: any destroy, drop, delete, rm, force, truncate, replace, terminate, kill, revoke, force-push, schema migration, data-loss potential, irreversible operation, credential rotation, network exposure, permission grant.",
  "- Treat as REVIEW: unverified side-effects, partial execution dumps, ambiguous diff sets, or indeterminate outcomes.",
  "- Output SAFE only when the output shows zero destructive or irreversible operations.",
  "- Always list the exact risky lines verbatim after the verdict so the reader can audit.",
  "- Never soften the verdict to please the reader."
].join(" ");

const FORMAT_CONSTRAINTS = [
  "You compress shell or command output for another model that will act on your answer.",
  "Format Constraints:",
  "- Output ONLY the requested format. No preamble. No 'Here is'. No explanation unless the question asks for one.",
  "- If the question asks for JSON, return raw JSON only, no fences.",
  "- If the question asks for a list, one item per line, no bullets, no numbering.",
  "- If the question asks for a list (paths, files, names) and nothing matches, output only NONE. Do not output an empty string, [], or Insufficient.",
  "- If the question asks PASS/FAIL/SAFE/REVIEW/UNSAFE, output that token first on the same line, then the supporting detail.",
  "- Match the language of the question.",
  "- Never invent data not present in the output. If a field is missing, omit it or say so explicitly.",
  '- If the output is insufficient, reply only with "condense: Insufficient information to output anything." in the language of the question.',
  "- If the source is already shorter than your answer would be, reuse the source wording.",
  "- Keep prose answers to one sentence, max three short lines. Structured answers (JSON, lists, multi-line tables) may be longer when the format requires it.",
  "- Never ask for more input."
].join(" ");

const CONDENSE_CORE_DIRECTIVES = [FORMAT_CONSTRAINTS, SAFETY_EVALUATION_GUIDELINES].join(
  " "
);

const MAX_INPUT_CHARS = 24000;
export const LOCAL_MAX_INPUT_CHARS = 8000;

export function fitInput(input: string, maxChars: number = MAX_INPUT_CHARS): string {
  if (input.length <= maxChars) {
    return input;
  }

  const half = Math.floor(maxChars / 2) - 50;
  const head = input.slice(0, half);
  const tail = input.slice(-half);
  const dropped = input.length - head.length - tail.length;

  return `${head}\n... [${dropped} chars truncated] ...\n${tail}`;
}

export function buildFixedBatchSystemPrompt(): string {
  return FORMAT_CONSTRAINTS;
}

export function buildBatchPrompt(
  question: string,
  input: string,
  options: BatchPromptOptions = {}
): PromptMessages {
  const dslRules = options.dslMemory
    ? [
        "Known /condense DSL memory:",
        options.dslMemory,
        "Use these learned aliases/macros/defaults when the requested output format allows DSL.",
        "When free-form /condense output is allowed, start with Dict only if needed, then use the active DSL keys.",
        "Do not redefine known entries. Emit Dict+ only for genuinely reusable new terms.",
        "When emitting Dict+, use the shortest unambiguous key: one letter or one number first, then one letter plus one number if needed."
      ].join("\n")
    : "";

  return {
    system: buildFixedBatchSystemPrompt(),
    user: [dslRules, `Command output:\n${fitInput(input, options.maxInputChars)}\n\nQuestion: ${question}`]
      .filter(Boolean)
      .join("\n\n")
  };
}

export function buildTranslatePrompt(text: string, language: string): PromptMessages {
  const system = [
    "You translate /condense output into human language for a software engineer.",
    "/condense output is compressed Military English + AR-0/AR-1 for prompts, task specs, commands, or agent instructions.",
    "It may contain Dict/Dict+, dynamic inline variables using <term>=#<letter><digit>, and fixed prefixes S, C, D, R, O, N, P.",
    "Prefix meanings are usually S=state/status, C=cause/context, D=action/decision, R=risk/blocker, O=outcome/output, N=constraint/no-go, P=pass criteria/proof.",
    "Expand # variables from Dict/Dict+ or inline assignments when present.",
    "It may also contain legacy sections such as Best, More aggressive, Tradeoff, T, Do, No, Pass, and Out.",
    "Expand short command lines into clear human language.",
    "Expand aliases from Dict and Dict+ when present. Keep aliases unchanged when no definition is present.",
    "Preserve constraints, pass criteria, required output, blockers, uncertainty, file names, paths, commands, environment variables, IDs, security warnings, production/data-loss warnings, and technical terms.",
    "If multiple variants are present, explain the Best variant first and summarize the more aggressive variant and its tradeoff.",
    "Do not invent missing facts. Do not claim execution happened unless the input says it happened.",
    "Write concise natural language in the requested language or locale.",
    "Return only the translation. No preamble. No markdown."
  ].join(" ");

  return {
    system,
    user: [
      `Target language: ${language}`,
      "",
      "/condense input:",
      fitInput(text, 4000)
    ].join("\n")
  };
}

export function buildDslPromotionPrompt(entries: string): PromptMessages {
  const system = [
    "You review learned /condense DSL entries for scope promotion.",
    "Return valid JSON only.",
    "Input entries are project-scoped active learned aliases/macros/defaults.",
    "Promote only generic, stable, non-sensitive operational language.",
    "Reject private project names, people, secrets, IDs, paths, URLs, one-off terms, or meanings that are too ambiguous outside the current project.",
    "Schema: [{\"key\":\"KEY\",\"decision\":\"promote|keep|reject\",\"targetScope\":\"stack|global|project\",\"reason\":\"short reason\"}]",
    "Use targetScope stack for stack-specific engineering shorthand.",
    "Use targetScope global only for universal agent workflow shorthand."
  ].join(" ");

  return {
    system,
    user: ["Entries:", fitInput(entries, 4000)].join("\n")
  };
}

export function buildThreadLearnPrompt(
  transcript: string,
  candidates: ThreadLearnPromptCandidate[],
  dslMemory: string
): PromptMessages {
  const system = [
    "You review /condense DSL candidates learned from a whole agent thread.",
    "Return valid JSON only.",
    "Input candidates were extracted deterministically from repeated thread usage.",
    "Keep only stable, reusable operational language that will reduce future repetition.",
    "Reject secrets, tokens, emails, URLs, file paths, IDs, hashes, personal names, package names, project-private names, one-off wording, and ambiguous meanings.",
    "Prefer the shortest unambiguous key: one letter or one number first, then letter+number.",
    "Accept # variable keys only when the transcript explicitly used term=#x1 syntax.",
    "Do not duplicate existing DSL memory. Do not overwrite pinned meanings.",
    "Use scope project unless the candidate is clearly generic for the requested scope.",
    "Schema: [{\"key\":\"A\",\"meaning\":\"short meaning\",\"kind\":\"alias|macro|default\",\"scope\":\"project|stack|global\",\"reason\":\"short reason\",\"confidence\":0.0}]",
    "Use confidence 0.65 or higher only when the candidate is safe to persist."
  ].join(" ");

  return {
    system,
    user: [
      "Existing active DSL memory:",
      dslMemory || "(empty)",
      "",
      "Deterministic candidates:",
      JSON.stringify(candidates, null, 2),
      "",
      "Thread transcript:",
      fitInput(transcript, 10000)
    ].join("\n")
  };
}

export function buildWatchPrompt(
  question: string,
  previousCycle: string,
  currentCycle: string,
  maxCycleChars: number = MAX_INPUT_CHARS
): PromptMessages {
  const watchRules = [
    "You compare two consecutive watch-mode cycles for another model that will act on your answer.",
    "Focus on what changed from the previous cycle to the current cycle.",
    'If nothing relevant changed, reply only with "No relevant change." in the language of the question.',
    SAFETY_EVALUATION_GUIDELINES,
    "Other rules below still apply."
  ].join(" ");

  return {
    system: `${watchRules}\n\n${CONDENSE_CORE_DIRECTIVES}`,
    user: [
      "Previous cycle:",
      fitInput(previousCycle, maxCycleChars),
      "",
      "Current cycle:",
      fitInput(currentCycle, maxCycleChars),
      "",
      `Question: ${question}`
    ].join("\n")
  };
}

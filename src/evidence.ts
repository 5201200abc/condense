export interface CriticalEvidence {
  lines: string[];
  anchors: string[];
  kind: "failure" | "risk";
}

export interface EvidenceQuality {
  modelContractPassed: boolean | null;
  contractPassed: boolean;
  required: number;
  retained: number;
  action: "none" | "repair" | "raw";
  abandonedTokens?: number;
  rejectionReason?: string;
}

export function cleanLog(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const WARNING = /\[console\.warn\]|^\s*(?:\[[^\]\n]+\]\s*)?warn(?:ing)?\b/i;
const HISTORY = /^\s*(?:\[history\]|history:|historical (?:error|reference):|previous run:|documentation example:)/i;
const ERROR = /\b(?:\w*Error|\w*Exception)(?:\s*\[[^\]\n]+\])?:\s*\S|\blocator\.\w+: Timeout \d+ms exceeded\b|^\s*(?:FAIL|FAILED|✗|×|\(fail\))\s+\S|(?:^|\s)[^\s]+\(\d+,\d+\):\s*error TS\d+|(?:^|\s)[^\s]+:\d+:\d+\s*[-:]\s*error TS\d+|^\s*[^\s]+\.py:\d+:\s*\w*(?:Error|Exception)\b|^\s*error(?:\[[^\]]+\])?:\s*\S|^\s*##\[error\]\S|\bProcess completed with exit code [1-9]\d*\b|^\s*\S+:\s*line \d+:.*(?:command not found|\bKilled\b)/;
const RISK = /will be destroyed|must be replaced|# forces replacement|\b[1-9]\d* to destroy\b/i;
// Preserve reported outcomes in model input without treating success as a failure
// or risk anchor in the output guard.
const OUTCOME = /^\s*(?:(?:Tests?|Test Suites):|\d+ (?:pass(?:ed)?|fail(?:ed)?)\b|(?:##\[error\])?Process completed with exit code \d+\.|Plan: \d+ to add, \d+ to change, \d+ to destroy\.|No changes\. Your infrastructure matches the configuration\.)/;
const FRAME = /^\s*at\s+\S/;
const CONTEXT = /^\s*(?:Call log:|[-·]|at\s|name:|actual:|expected:|received:|operator:|code:|\}|\{|\^)|^\s*\d+\s*(?:\||[×x])/i;

/** Scan every line before any budget is applied. Repeated messages/frames are deduplicated. */
export function extractCriticalEvidence(input: string): CriticalEvidence {
  const lines = cleanLog(input).split("\n");
  const selected: string[] = [];
  const anchors: string[] = [];
  const seen = new Set<string>();
  let kind: CriticalEvidence["kind"] = "risk";
  const add = (line: string, anchor = line.trim(), key = anchor) => {
    if (!line.includes(anchor)) anchor = line.trim();
    if (!anchor || seen.has(key)) return;
    seen.add(key);
    selected.push(line);
    anchors.push(anchor);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (WARNING.test(line) || HISTORY.test(line)) continue;
    const failure = ERROR.test(line) || /^\s*name:\s*['"]TimeoutError['"]/.test(line);
    const risk = RISK.test(line);
    if (!failure && !risk) continue;
    if (failure) kind = "failure";
    // Structured reporters often repeat an earlier error and its entire stack in JSON.
    let anchor = line.trim();
    let key: string | undefined;
    const objectStart = line.indexOf('{"');
    if (objectStart >= 0) {
      try {
        const object = JSON.parse(line.slice(objectStart));
        if (typeof object.message === "string" && typeof object.name === "string") {
          key = `${object.name}: ${object.message}`;
          anchor = JSON.stringify(object.message);
        }
      } catch {}
    } else {
      const errorStart = line.search(ERROR);
      if (errorStart >= 0) anchor = line.slice(errorStart).trim();
    }
    add(line, anchor, key);
    // Python traceback locations precede the final exception message.
    if (failure) {
      for (let j = i - 1; j >= 0; j--) {
        const prior = lines[j];
        if (/^\s*File "[^"]+", line \d+/.test(prior)) add(prior);
        else if (prior.trim() && !/^\s/.test(prior)) break;
      }
    }
    // Keep actionable locations and locator diagnostics; skip dependency frames and retries.
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (!next.trim()) continue;
      if (ERROR.test(next) || WARNING.test(next) || !CONTEXT.test(next)) break;
      if (FRAME.test(next)) {
        if (!/node_modules|node:internal|<anonymous>|UtilityScript|triggerUncaughtException/.test(next)) add(next);
      } else if (/waiting for (?:getBy|locator)|element is (?:not |outside)|intercepts pointer events|\b(?:actual|expected|received|operator|code|name):|^\s*\d+\s*\|/i.test(next)) {
        add(next);
      }
    }
  }
  return { lines: selected, anchors, kind };
}

export function requestsEvidence(question?: string): boolean {
  return !!question && /\b(?:failing|failed|failure)\s+(?:items?|tests?|cases?|commands?|details?)\b|\b(?:raw|original)\s+(?:error|failure)|\b(?:list|include|show|report|provide)\b[^\n?]*\b(?:errors?|failures?|risks?|risky changes|destructive changes)\b|\bsummari[sz]e\b|失败项|原始错误|错误详情|列出.*(?:错误|失败|风险)|总结|压缩/i.test(question);
}

export function assessEvidence(evidence: CriticalEvidence, output: string): number {
  const normalized = cleanLog(output);
  return evidence.anchors.filter((anchor) => normalized.includes(anchor)).length;
}

function assessOutcome(input: string, evidence: CriticalEvidence, question?: string) {
  const lines = cleanLog(input).split("\n").filter((line) => !WARNING.test(line) && !HISTORY.test(line));
  const proof: string[] = [];
  const passed = new Set<number>(), failed = new Set<number>(), exits = new Set<number>();
  let safePlan = false, noChanges = false, zeroTests = false;
  for (const line of lines) {
    const stats = line.match(/^\s*(?:Tests?:\s*)?(\d+) passed, (\d+) failed\b/i);
    const pass = line.match(/^\s*(\d+) pass(?:ed)?\b/i);
    const fail = line.match(/^\s*(\d+) fail(?:ed)?\b/i);
    const exit = line.match(/^\s*(?:##\[error\])?Process completed with exit code (\d+)\./);
    if (stats) { passed.add(Number(stats[1])); failed.add(Number(stats[2])); proof.push(line); }
    else if (pass) { passed.add(Number(pass[1])); proof.push(line); }
    else if (fail) { failed.add(Number(fail[1])); proof.push(line); }
    if (exit) { exits.add(Number(exit[1])); proof.push(line); }
    if (/^\s*Plan: 0 to add, 0 to change, 0 to destroy\./.test(line)) { safePlan = true; proof.push(line); }
    if (/^\s*No changes\. Your infrastructure matches the configuration\./.test(line)) { noChanges = true; proof.push(line); }
    zeroTests ||= /\b(?:no tests (?:ran|found)|ran 0 tests|0 tests collected)\b/i.test(line);
  }
  zeroTests ||= passed.has(0) && ![...passed].some((n) => n > 0);
  const hasErrors = evidence.anchors.length > 0;
  const safe = safePlan && noChanges;
  const conflict = (hasErrors && (exits.has(0) || safe)) || exits.size > 1 ||
    passed.size > 1 || failed.size > 1 || ((safe || exits.has(0)) && [...failed].some((n) => n > 0));
  const successful = exits.size === 1 && exits.has(0) && !zeroTests && !hasErrors &&
    ![...failed].some((n) => n > 0) &&
    (!/\btests?\b|测试/i.test(question ?? "") || [...passed].some((n) => n > 0));
  return { conflict, verdict: safe && !hasErrors ? "SAFE" : successful ? "PASS" : undefined,
    proof: [...new Set(proof)], zeroTests };
}

export function enforceEvidenceContract(input: string, summary: string, question?: string): {
  output: string;
  quality?: EvidenceQuality;
} {
  const evidence = extractCriticalEvidence(input);
  const details = requestsEvidence(question);
  const statusRequest = /\bPASS\b.*\bFAIL\b|\bFAIL\b.*\bPASS\b|\bSAFE\b.*\bUNSAFE\b|\bUNSAFE\b.*\bSAFE\b/i.test(question ?? "");
  if (!details && !statusRequest) return { output: summary.trim() };
  const outcome = assessOutcome(input, evidence, question);
  const uncertain = (reason: string) => ({ output: input, quality: {
    modelContractPassed: false, contractPassed: false,
    required: details ? evidence.anchors.length : 0,
    retained: details ? evidence.anchors.length : 0,
    action: "raw" as const, rejectionReason: reason
  } });
  if (outcome.conflict) return uncertain("conflicting_outcomes");
  if (!evidence.anchors.length) {
    const positive = /\bSAFE\b|\bUNSAFE\b/i.test(question ?? "") ? outcome.verdict === "SAFE" : outcome.verdict === "PASS";
    if (positive) {
      const verdict = outcome.verdict!;
      const claimedFailure = cleanLog(summary).split("\n").some((line) => !WARNING.test(line) && !HISTORY.test(line) && ERROR.test(line));
      const modelContractPassed = new RegExp(`^${verdict}\\b`).test(summary.trim()) && !claimedFailure;
      if (modelContractPassed) return { output: summary.trim(), quality: {
        modelContractPassed: true, contractPassed: true, required: 0, retained: 0, action: "none"
      } };
      const output = details ? `${verdict}\n${outcome.proof.join("\n")}` : verdict;
      return { output, quality: {
        modelContractPassed: false, contractPassed: true, required: 0, retained: 0, action: "repair",
        rejectionReason: /^(?:FAIL|UNSAFE)\b/.test(summary.trim()) || claimedFailure ? "false_failure" : "incomplete_outcome"
      } };
    }
    if (summary.trim() === "condense: Insufficient information to output anything.") return { output: summary.trim() };
    if (statusRequest || /^(?:PASS|FAIL|SAFE|UNSAFE)\b/.test(summary.trim())) return uncertain("unverified_outcome");
    return { output: summary.trim() };
  }
  const retained = details ? assessEvidence(evidence, summary) : 0;
  const required = details ? evidence.anchors.length : 0;
  const verdict = /\bSAFE\b|\bUNSAFE\b/i.test(question ?? "") || evidence.kind === "risk" ? "UNSAFE" : "FAIL";
  const requiresVerdict = /PASS.*FAIL|FAIL.*PASS|SAFE|UNSAFE/i.test(question ?? "");
  const modelContractPassed = retained === required &&
    (!requiresVerdict || new RegExp(`^${verdict}\\b`).test(summary.trim()));
  if (modelContractPassed) {
    return { output: summary.trim(), quality: {
      modelContractPassed: true, contractPassed: true,
      required, retained, action: "none"
    } };
  }
  const repair = details ? `${verdict}\n${evidence.lines.join("\n")}` : verdict;
  const repairedRetained = details ? assessEvidence(evidence, repair) : 0;
  const canRepair = repair.length < input.length * 0.8 && repairedRetained === required;
  return { output: canRepair ? repair : input, quality: {
    modelContractPassed: false,
    contractPassed: canRepair || !requiresVerdict || new RegExp(`^${verdict}\\b`).test(cleanLog(input)),
    required, retained: required,
    action: canRepair ? "repair" : "raw"
  } };
}

export class EvidenceBudgetExceeded extends Error {
  constructor() { super("Critical evidence exceeds the model input budget."); }
}

/** Reserve error blocks first, then spend the remaining budget on balanced head/tail context. */
export function fitEvidenceInput(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  const evidence = extractCriticalEvidence(input);
  const outcomes = cleanLog(input).split("\n").filter((line) => OUTCOME.test(line));
  const critical = [...new Set([...evidence.lines, ...outcomes])].join("\n");
  const marker = `\n... [chars truncated; critical evidence retained] ...\n`;
  if (critical.length + marker.length > maxChars) throw new EvidenceBudgetExceeded();
  const remaining = maxChars - critical.length - marker.length - 5;
  if (remaining < 0) throw new EvidenceBudgetExceeded();
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return `${critical}${marker}${input.slice(0, head)}\n...\n${tail ? input.slice(-tail) : ""}`;
}

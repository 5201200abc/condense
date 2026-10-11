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
const ERROR = /\b(?:\w*Error|\w*Exception)(?:\s*\[[^\]\n]+\])?:\s*\S|\blocator\.\w+: Timeout \d+ms exceeded\b|^\s*(?:FAIL|FAILED|✗|×)\s+\S|(?:^|\s)[^\s]+\(\d+,\d+\):\s*error TS\d+|^\s*error(?:\[[^\]]+\])?:\s*\S/;
const RISK = /will be destroyed|must be replaced|# forces replacement|\b[1-9]\d* to destroy\b/i;
const FRAME = /^\s*at\s+\S/;
const CONTEXT = /^\s*(?:Call log:|[-·]|at\s|name:|actual:|expected:|operator:|code:|\}|\{|\^)|^\s*\d+\s*(?:\||[×x])/;

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
    if (WARNING.test(line)) continue;
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
      } else if (/waiting for (?:getBy|locator)|element is (?:not |outside)|intercepts pointer events|\b(?:actual|expected|operator|code|name):|^\s*\d+\s*\|/.test(next)) {
        add(next);
      }
    }
  }
  return { lines: selected, anchors, kind };
}

export function requestsEvidence(question?: string): boolean {
  return !!question && /\b(?:failing|failed|failure)\s+(?:items?|tests?|cases?|commands?|details?)\b|\b(?:raw|original)\s+(?:error|failure)|\b(?:list|include|show|report|provide)\b[^\n?]*\b(?:errors?|failures?|risks?)\b|\bsummari[sz]e\b|失败项|原始错误|错误详情|列出.*(?:错误|失败|风险)|总结|压缩/i.test(question);
}

export function assessEvidence(evidence: CriticalEvidence, output: string): number {
  const normalized = cleanLog(output);
  return evidence.anchors.filter((anchor) => normalized.includes(anchor)).length;
}

export function enforceEvidenceContract(input: string, summary: string, question?: string): {
  output: string;
  quality?: EvidenceQuality;
} {
  const evidence = extractCriticalEvidence(input);
  const details = requestsEvidence(question);
  const statusRequest = /\bPASS\b.*\bFAIL\b|\bFAIL\b.*\bPASS\b|\bSAFE\b.*\bUNSAFE\b|\bUNSAFE\b.*\bSAFE\b/i.test(question ?? "");
  if (!evidence.anchors.length || (!details && !statusRequest)) return { output: summary.trim() };
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
  const critical = evidence.lines.join("\n");
  const marker = `\n... [chars truncated; critical evidence retained] ...\n`;
  if (critical.length + marker.length > maxChars) throw new EvidenceBudgetExceeded();
  const remaining = maxChars - critical.length - marker.length - 5;
  if (remaining < 0) throw new EvidenceBudgetExceeded();
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return `${critical}${marker}${input.slice(0, head)}\n...\n${tail ? input.slice(-tail) : ""}`;
}

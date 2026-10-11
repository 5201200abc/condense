import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fixtures from "../../test/fixtures/v2-failure-contract.json";
import { estimateTokens, type SingleRunStat } from "../../src/stats";

// Measures the compiled CLI and an already running local v2 server, including
// process startup, stdin, inference, output and persistence. No production files
// are modified. Labels below are independent of the runtime evidence extractor.
const root = path.resolve(import.meta.dir, "../..");
const binary = path.resolve(process.argv[2] ?? path.join(root, `packages/condense-${process.platform}-${process.arch}/bin/condense`));
const reportPath = path.resolve(process.argv[3] ?? path.join(import.meta.dir, "runtime_quality_report.json"));
const labels: Record<string, string[]> = {
  "7c350a4b": ["locator.click: Timeout 45000ms exceeded.", "mycode-compact-entrypoints.mjs:89:14"],
  "60e3517f": ["locator.waitFor: Timeout 45000ms exceeded.", "`Tooltip` must be used within `TooltipProvider`", "mycode-composer-details.mjs:311:17"],
  "9d445347": ["locator.click: Timeout 45000ms exceeded.", "useMyCodeIntl 必须在 MyCodeIntlProvider 内使用", "mycode-capability-settings.mjs:44:53"],
  "e59e3eb7": ["locator.evaluate: Timeout 45000ms exceeded.", "Unable to find an active editor state.", "mycode-compact-entrypoints.mjs:15:17"]
};
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CONDENSE_")));
const scratch = await mkdtemp(path.join(tmpdir(), "condense-runtime-quality-"));
type Row = Awaited<ReturnType<typeof replay>>;

function memory() {
  if (process.platform === "win32") return null;
  const result = spawnSync("ps", ["-eo", "pid,rss,comm"], { encoding: "utf8" });
  return result.stdout.split("\n").filter((line) => /llama-server(?:\s|$)/.test(line)).map((line) => {
    const [pid, rssKiB] = line.trim().split(/\s+/);
    return { pid: Number(pid), rssMiB: Math.round(Number(rssKiB) / 1024 * 100) / 100 };
  });
}

async function replay(fixture: typeof fixtures[number], phase: string, index: number) {
  const id = fixture.request_id.slice(0, 8);
  const dir = path.join(scratch, `${phase}-${index}`);
  const env = {
    ...baseEnv,
    CONDENSE_CONFIG_PATH: path.join(dir, "config.json"),
    CONDENSE_STATS_PATH: path.join(dir, "stats.json"),
    CONDENSE_OBSERVE_PATH: path.join(dir, "observe.jsonl"),
    CONDENSE_RECALL_PATH: path.join(dir, "recall.db"),
    CONDENSE_PROVIDER: "local", CONDENSE_LOCAL_BACKEND: "llamacpp",
    CONDENSE_LLAMA_GGUF: path.join(root, "train/gguf/v2/condense-0.8B-Q4_K_M.gguf"),
    CONDENSE_LOCAL_HOST: "127.0.0.1", CONDENSE_LOCAL_PORT: "8009",
    CONDENSE_AUTO_LEARN: "false", CONDENSE_DATASET_ENABLED: "false"
  };
  const started = performance.now();
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(binary, [fixture.question], { cwd: scratch, env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
    child.stdin.end(fixture.raw_input);
  });
  const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
  const stats = JSON.parse(await readFile(env.CONDENSE_STATS_PATH, "utf8")) as { recent: SingleRunStat[] };
  const stat = stats.recent[0];
  const missing = labels[id].filter((anchor) => !result.stdout.includes(anchor));
  const passed = result.code === 0 && /^FAIL\b/.test(result.stdout) && !missing.length;
  return {
    id, phase, index, elapsedMs, exitCode: result.code,
    inputChars: fixture.raw_input.length, outputChars: result.stdout.length,
    requiredAnchors: labels[id].length, retainedAnchors: labels[id].length - missing.length,
    missing, contractPassed: passed, modelContractPassed: stat.quality?.modelContractPassed,
    guardAction: stat.quality?.action, cacheN: stat.cacheN ?? 0, promptN: stat.promptN ?? 0,
    inferenceMs: stat.durationMs, recordedEndToEndMs: stat.endToEndMs,
    effectiveTokensSaved: passed && result.stdout.length < fixture.raw_input.length ? Math.max(0, estimateTokens(fixture.raw_input) - estimateTokens(result.stdout)) : 0,
    stderr: result.stderr || undefined
  };
}

function summarize(rows: Row[]) {
  const passed = rows.filter((row) => row.contractPassed);
  const effective = passed.filter((row) => row.effectiveTokensSaved > 0);
  const elapsed = effective.map((row) => row.elapsedMs).sort((a, b) => a - b);
  const sum = (key: "requiredAnchors" | "retainedAnchors" | "effectiveTokensSaved" | "cacheN" | "promptN") => rows.reduce((n, row) => n + row[key], 0);
  return {
    samples: rows.length, contractPassRate: 100 * passed.length / rows.length,
    criticalEvidenceRecall: 100 * sum("retainedAnchors") / sum("requiredAnchors"),
    effectiveTokensSaved: sum("effectiveTokensSaved"), effectiveCalls: effective.length,
    endToEndP95Ms: elapsed.length ? elapsed[Math.ceil(elapsed.length * 0.95) - 1] : null,
    cacheHitCalls: rows.filter((row) => row.cacheN > 0).length,
    cacheN: sum("cacheN"), evaluatedPromptN: sum("promptN"),
    guardRepairs: rows.filter((row) => row.guardAction === "repair").length,
    rawFallbacks: rows.filter((row) => row.guardAction === "raw").length
  };
}

try {
  const before = memory();
  const serial: Row[] = [];
  for (const fixture of fixtures) {
    for (let repeat = 0; repeat < 5; repeat++) {
      const row = await replay(fixture, "serial", serial.length);
      serial.push(row);
      console.log(`${row.id} ${repeat + 1}/5 ${row.contractPassed ? "PASS" : "FAIL"} ${row.elapsedMs}ms ${row.inputChars} -> ${row.outputChars} chars cache=${row.cacheN}`);
    }
  }
  const concurrentStarted = performance.now();
  const concurrent = await Promise.all(fixtures.map((fixture, index) => replay(fixture, "concurrent", index)));
  const concurrentWallMs = Math.round((performance.now() - concurrentStarted) * 100) / 100;
  const report = {
    recordedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`,
    scope: "Four known production failures; local v2 resident server. This does not re-score the old 100-case semantic benchmark.",
    binary, residentServerMemory: { before, after: memory(), note: "Sampled process RSS; excludes Metal/GPU allocations and is not a peak-memory measurement." },
    serial: { ...summarize(serial), rows: serial },
    concurrent: { ...summarize(concurrent), concurrency: fixtures.length, wallMs: concurrentWallMs, rows: concurrent }
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ serial: summarize(serial), concurrent: summarize(concurrent), concurrentWallMs, reportPath }));
  if ([...serial, ...concurrent].some((row) => !row.contractPassed || !row.effectiveTokensSaved)) process.exitCode = 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}

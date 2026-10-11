import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { evaluateRobustnessOutput, robustnessCases } from "./robustness-cases";
import { estimateTokens, type SingleRunStat } from "../../src/stats";

const root = path.resolve(import.meta.dir, "../..");
const binary = path.resolve(process.argv[2] ?? path.join(root, `packages/condense-${process.platform}-${process.arch}/bin/condense`));
const reportPath = path.resolve(process.argv[3] ?? path.join(import.meta.dir, "robustness_pipeline_report.json"));
const upstream = process.env.CONDENSE_BENCH_SERVER ?? "http://127.0.0.1:8009";
const scratch = await mkdtemp(path.join(tmpdir(), "condense-robustness-"));
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CONDENSE_")));
let activeId = "";
const captured = new Map<string, { output: string; input: string }>();

// Transparent HTTP observation keeps provider=local and its actual 8K budget.
// The same inference response is evaluated before and after the Runtime Guard.
const proxy = Bun.serve({
  hostname: "127.0.0.1", port: 0, idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "GET" ? undefined : await request.text();
    const id = activeId;
    const response = await fetch(new URL(url.pathname + url.search, upstream), {
      method: request.method, body, headers: { "content-type": "application/json" }
    });
    const text = await response.text();
    if (body && url.pathname === "/v1/chat/completions") {
      const payload = JSON.parse(body);
      const user = payload.messages?.find((message: { role: string; content: string }) => message.role === "user" && message.content.includes("Command output:\n"));
      if (user) {
        const completion = JSON.parse(text);
        captured.set(id, {
          output: completion.choices?.[0]?.message?.content ?? "",
          input: user.content.split("Command output:\n")[1].split("\n\nQuestion: ")[0]
        });
      }
    }
    return new Response(text, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
  }
});

async function run(fixture: typeof robustnessCases[number]) {
  activeId = fixture.id;
  const dir = path.join(scratch, fixture.id);
  const env = {
    ...baseEnv, CONDENSE_PROVIDER: "local", CONDENSE_LOCAL_BACKEND: "llamacpp",
    CONDENSE_LOCAL_HOST: "127.0.0.1", CONDENSE_LOCAL_PORT: String(proxy.port),
    CONDENSE_CONFIG_PATH: path.join(dir, "config.json"), CONDENSE_STATS_PATH: path.join(dir, "stats.json"),
    CONDENSE_OBSERVE_PATH: path.join(dir, "observe.jsonl"), CONDENSE_RECALL_PATH: path.join(dir, "recall.db"),
    CONDENSE_AUTO_LEARN: "false", CONDENSE_DATASET_ENABLED: "false"
  };
  const started = performance.now();
  const result = await new Promise<{ code: number | null; output: string; stderr: string }>((resolve, reject) => {
    const child = spawn(binary, [fixture.question], { cwd: scratch, env, stdio: ["pipe", "pipe", "pipe"] });
    const output: Buffer[] = [], stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output: Buffer.concat(output).toString(), stderr: Buffer.concat(stderr).toString() }); });
    child.stdin.end(fixture.input);
  });
  const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
  const stats = JSON.parse(await readFile(env.CONDENSE_STATS_PATH, "utf8")) as { recent: SingleRunStat[] };
  const stat = stats.recent[0];
  const inference = captured.get(fixture.id);
  const model = inference ? evaluateRobustnessOutput(fixture, inference.output) : null;
  const pipeline = evaluateRobustnessOutput(fixture, result.output);
  if (result.code !== 0) pipeline.contractPassed = false;
  const missingFromModelInput = inference ? fixture.inputRequired.filter((anchor) => !inference.input.includes(anchor)) : fixture.inputRequired;
  const expectedNoRepair = !fixture.guard && !fixture.statusOnly;
  const falseRepair = expectedNoRepair && stat.quality?.action !== undefined && stat.quality.action !== "none";
  return {
    id: fixture.id, family: fixture.family, position: fixture.position, expectedVerdict: fixture.verdict,
    inputChars: fixture.input.length, outputChars: result.output.length, elapsedMs,
    modelInputChars: inference?.input.length ?? null, requiredInputAnchors: fixture.inputRequired.length, missingFromModelInput,
    inputContractPassed: !!inference && inference.input.length <= 8000 && missingFromModelInput.length === 0,
    model, pipeline, guardAction: stat.quality?.action ?? "unassessed", falseRepair,
    runtimeQuality: stat.quality ?? null, cacheN: stat.cacheN ?? 0,
    effectiveTokensSaved: pipeline.contractPassed && !falseRepair && result.output.length < fixture.input.length
      ? Math.max(0, estimateTokens(fixture.input) - estimateTokens(result.output)) : 0,
    modelOutput: inference?.output ?? null, output: result.output, stderr: result.stderr || undefined
  };
}

type Row = Awaited<ReturnType<typeof run>>;
function summary(rows: Row[]) {
  const model = rows.flatMap((row) => row.model ? [row.model] : []);
  const pipeline = rows.map((row) => row.pipeline);
  const percentage = (n: number, total: number) => total ? Math.round(10000 * n / total) / 100 : null;
  const recall = (results: typeof pipeline) => percentage(results.reduce((n, r) => n + r.retained, 0), results.reduce((n, r) => n + r.required, 0));
  const effective = rows.filter((row) => row.effectiveTokensSaved > 0);
  const latency = effective.map((row) => row.elapsedMs).sort((a, b) => a - b);
  return {
    cases: rows.length, modelAssessed: model.length,
    modelContractPassRate: percentage(model.filter((r) => r.contractPassed).length, model.length),
    pipelineContractPassRate: percentage(pipeline.filter((r) => r.contractPassed).length, pipeline.length),
    modelCriticalEvidenceRecall: recall(model), pipelineCriticalEvidenceRecall: recall(pipeline),
    modelInputEvidenceRecall: percentage(rows.reduce((n, r) => n + r.requiredInputAnchors - r.missingFromModelInput.length, 0), rows.reduce((n, r) => n + r.requiredInputAnchors, 0)),
    modelInputBudgetViolations: rows.filter((r) => r.modelInputChars !== null && r.modelInputChars > 8000).length,
    guardRepairs: rows.filter((row) => row.guardAction === "repair").length,
    rawFallbacks: rows.filter((row) => row.guardAction === "raw").length,
    falseRepairs: rows.filter((row) => row.falseRepair).length,
    effectiveTokensSaved: rows.reduce((n, row) => n + row.effectiveTokensSaved, 0), effectiveCalls: effective.length,
    endToEndP95Ms: latency.length ? latency[Math.ceil(latency.length * 0.95) - 1] : null,
    failedCases: rows.filter((row) => !row.pipeline.contractPassed || !row.inputContractPassed || row.falseRepair).map((row) => row.id)
  };
}

try {
  const rows: Row[] = [];
  for (const fixture of robustnessCases) {
    const row = await run(fixture);
    rows.push(row);
    console.log(`${row.id}: ${row.pipeline.contractPassed && !row.falseRepair ? "PASS" : "FAIL"}; model=${row.model?.contractPassed}; missing=${JSON.stringify(row.pipeline.missing)}; ${row.elapsedMs}ms`);
  }
  const report = {
    recordedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, binary,
    binarySha256: createHash("sha256").update(await readFile(binary)).digest("hex"),
    scope: "18 newly authored synthetic format cases with independent gold labels; not a held-out production sample, and not a re-score of the old 100-case benchmark.",
    method: "One compiled local CLI invocation per case. A transparent proxy captures the same model response and actual 8K-budget input; independent gold labels evaluate both outputs.",
    summary: summary(rows), families: Object.fromEntries([...new Set(rows.map((r) => r.family))].map((family) => [family, summary(rows.filter((r) => r.family === family))])), rows
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report.summary, reportPath }));
  if (report.summary.failedCases.length) process.exitCode = 1;
} finally {
  proxy.stop(true);
  await rm(scratch, { recursive: true, force: true });
}

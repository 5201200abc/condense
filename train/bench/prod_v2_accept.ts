import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveRuntimeDefaults, type RuntimeConfig } from "../../src/config";
import { summarizeBatch } from "../../src/llm";

const ROOT = path.resolve(import.meta.dir, "../..");
const GGUF = path.join(ROOT, "train/gguf/v2/condense-0.8B-Q4_K_M.gguf");
const PREV = path.join(ROOT, "train/bench/official_vs_distill2.json");
const Q4_REF = path.join(ROOT, "train/bench/v2_f16_align.json");
const OUT = path.join(ROOT, "train/bench/prod_v2_accept.json");
const QUESTION_MARK = "\n\nQuestion: ";

process.env.CONDENSE_LLAMA_GGUF = GGUF;
process.env.CONDENSE_PROVIDER = "local";
process.env.CONDENSE_LOCAL_BACKEND = "llamacpp";
process.env.CONDENSE_AUTO_LEARN = "false";
process.env.CONDENSE_DATASET_ENABLED = "false";

function loadJsonl(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function tasks(): Array<{ id: string; task: string }> {
  const prev = JSON.parse(readFileSync(PREV, "utf8")) as {
    results: Array<{ model: string; id: string; task: string }>;
  };
  const seen = new Set<string>();
  const out: Array<{ id: string; task: string }> = [];
  for (const row of prev.results) {
    if (row.model !== "distill2-0.6B" || seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    out.push({ id: row.id, task: row.task });
  }
  return out;
}

function catalog(): Map<string, { user: string; gold: string }> {
  const map = new Map<string, { user: string; gold: string }>();
  for (const name of ["train.jsonl", "valid.jsonl", "accepted.jsonl"]) {
    const file = path.join(ROOT, "train/data/labeled", name);
    try {
      for (const row of loadJsonl(file)) {
        const id = (row.metadata as { id?: string } | undefined)?.id;
        const messages = row.messages as Array<{ role: string; content: string }>;
        if (!id || !messages) {
          continue;
        }
        map.set(id, {
          user: messages.find((m) => m.role === "user")?.content ?? "",
          gold: messages.find((m) => m.role === "assistant")?.content ?? ""
        });
      }
    } catch {
      // missing split
    }
  }
  return map;
}

function splitUser(user: string): { output: string; question: string } {
  const at = user.lastIndexOf(QUESTION_MARK);
  if (at < 0) {
    throw new Error("labeled user missing Question marker");
  }
  const body = user.slice(0, at);
  const question = user.slice(at + QUESTION_MARK.length);
  const prefix = "Command output:\n";
  const output = body.startsWith(prefix) ? body.slice(prefix.length) : body;
  return { output, question };
}

function q4Ref(): Map<string, string> {
  const data = JSON.parse(readFileSync(Q4_REF, "utf8")) as {
    results: Array<{ model: string; id: string; pred: string }>;
  };
  const map = new Map<string, string>();
  for (const row of data.results) {
    if (row.model === "v2-q4-from-nop1-chat") {
      map.set(row.id, row.pred);
    }
  }
  return map;
}

const refs = q4Ref();
const rows = catalog();
const config: RuntimeConfig = {
  question: "unused",
  ...resolveRuntimeDefaults(process.env, {})
};
const results = [];
let matches = 0;

for (const task of tasks()) {
  const src = rows.get(task.id);
  if (!src) {
    throw new Error(`missing labeled ${task.id}`);
  }
  const { output, question } = splitUser(src.user);
  const started = Date.now();
  const pred = (await summarizeBatch({ ...config, question }, output)).trim();
  const sec = (Date.now() - started) / 1000;
  const ref = refs.get(task.id) ?? "";
  const same =
    pred === ref ||
    (ref.length > 0 && pred.startsWith(ref)) ||
    (pred.length > 0 && ref.startsWith(pred));
  matches += same ? 1 : 0;
  results.push({
    id: task.id,
    task: task.task,
    gold: src.gold.slice(0, 240),
    pred: pred.slice(0, 500),
    ref: ref.slice(0, 500),
    match_q4: same,
    sec
  });
  console.log(
    `${task.task} match=${same} ${sec}s ${pred.slice(0, 120).replaceAll("\n", " / ")}`
  );
}

writeFileSync(
  OUT,
  `${JSON.stringify({ n: results.length, matches, gguf: GGUF, results }, null, 2)}\n`
);
console.log(JSON.stringify({ n: results.length, matches }));
if (matches !== results.length) {
  process.exit(1);
}

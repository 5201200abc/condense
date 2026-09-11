import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { resolveConfigBaseDir } from "./user-config";

export interface RecallSnapshot {
  requestId: string;
  timestamp?: string;
  projectPath: string;
  question: string;
  rawInput: string;
  output: string;
  rawChars: number;
  rawBytes?: number;
  outputChars: number;
  rawEstimatedTokens: number;
  outputEstimatedTokens: number;
}

export interface RecallRecord {
  request_id: string;
  timestamp: string;
  project_path: string;
  question: string;
  raw_input: string;
  output: string;
  raw_chars: number;
  raw_bytes: number;
  output_chars: number;
  raw_estimated_tokens: number;
  output_estimated_tokens: number;
}

export function resolveRecallDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CONDENSE_RECALL_PATH?.trim();
  if (explicit) {
    return explicit;
  }
  return path.join(resolveConfigBaseDir(env), "recall.db");
}

export function ensureDbPermissions(dbPath: string): void {
  try {
    chmodSync(dbPath, 0o600);
  } catch {}
  for (const ext of ["-wal", "-shm"]) {
    const side = `${dbPath}${ext}`;
    if (existsSync(side)) {
      try {
        chmodSync(side, 0o600);
      } catch {}
    }
  }
}

export function openRecallDb(dbPath: string): Database {
  mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath);
  ensureDbPermissions(dbPath);
  db.run("PRAGMA journal_mode = WAL;");
  db.run(`
    CREATE TABLE IF NOT EXISTS recalls (
      request_id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      project_path TEXT NOT NULL,
      question TEXT NOT NULL,
      raw_input TEXT NOT NULL,
      output TEXT NOT NULL,
      raw_chars INTEGER NOT NULL,
      raw_bytes INTEGER NOT NULL DEFAULT 0,
      output_chars INTEGER NOT NULL,
      raw_estimated_tokens INTEGER NOT NULL,
      output_estimated_tokens INTEGER NOT NULL
    );
  `);
  try {
    db.run("ALTER TABLE recalls ADD COLUMN raw_bytes INTEGER NOT NULL DEFAULT 0;");
  } catch {}
  db.run("CREATE INDEX IF NOT EXISTS idx_recalls_timestamp ON recalls(timestamp DESC);");
  db.run("CREATE INDEX IF NOT EXISTS idx_recalls_project ON recalls(project_path);");
  ensureDbPermissions(dbPath);
  return db;
}

export const DEFAULT_RECALL_MAX_RECORDS = 1000;
export const DEFAULT_RECALL_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

export function pruneRecallSnapshots(
  db: Database,
  options: {
    maxRecords?: number;
    maxBytes?: number;
  } = {}
): { prunedCount: number } {
  const maxRecords = options.maxRecords ?? DEFAULT_RECALL_MAX_RECORDS;
  const maxBytes = options.maxBytes ?? DEFAULT_RECALL_MAX_BYTES;
  let prunedCount = 0;

  // 1. Cap total record count
  const countRow = db.prepare("SELECT COUNT(*) as count FROM recalls").get() as
    | { count: number }
    | undefined;
  const currentCount = countRow?.count ?? 0;
  if (currentCount > maxRecords) {
    const excess = currentCount - maxRecords;
    const info = db.run(
      `
      DELETE FROM recalls WHERE request_id IN (
        SELECT request_id FROM recalls ORDER BY timestamp ASC LIMIT ?
      )
    `,
      [excess]
    );
    prunedCount += info.changes;
  }

  // 2. Cap total raw input bytes (true UTF-8 byte length)
  const totalRow = db
    .prepare("SELECT COALESCE(SUM(raw_bytes), 0) as total FROM recalls")
    .get() as { total: number } | undefined;
  const currentTotal = totalRow?.total ?? 0;
  if (currentTotal > maxBytes) {
    const info = db.run(
      `
      DELETE FROM recalls WHERE request_id IN (
        SELECT request_id FROM (
          SELECT request_id,
                 SUM(raw_bytes) OVER (ORDER BY timestamp DESC) as running,
                 ROW_NUMBER() OVER (ORDER BY timestamp DESC) as rn
          FROM recalls
        ) WHERE running > ? AND rn > 1
      )
    `,
      [maxBytes]
    );
    prunedCount += info.changes;
  }

  return { prunedCount };
}

export async function recordRecallSnapshot(
  env: NodeJS.ProcessEnv,
  snapshot: RecallSnapshot
): Promise<void> {
  const dbPath = resolveRecallDbPath(env);
  const db = openRecallDb(dbPath);
  try {
    const timestamp = snapshot.timestamp ?? new Date().toISOString();
    const rawBytes =
      snapshot.rawBytes ?? Buffer.byteLength(snapshot.rawInput, "utf8");
    const query = db.prepare(`
      INSERT OR REPLACE INTO recalls (
        request_id,
        timestamp,
        project_path,
        question,
        raw_input,
        output,
        raw_chars,
        raw_bytes,
        output_chars,
        raw_estimated_tokens,
        output_estimated_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    query.run(
      snapshot.requestId,
      timestamp,
      snapshot.projectPath,
      snapshot.question,
      snapshot.rawInput,
      snapshot.output,
      snapshot.rawChars,
      rawBytes,
      snapshot.outputChars,
      snapshot.rawEstimatedTokens,
      snapshot.outputEstimatedTokens
    );

    const envMaxRecords = env.CONDENSE_RECALL_MAX_RECORDS
      ? parseInt(env.CONDENSE_RECALL_MAX_RECORDS, 10)
      : NaN;
    const envMaxBytes = env.CONDENSE_RECALL_MAX_BYTES
      ? parseInt(env.CONDENSE_RECALL_MAX_BYTES, 10)
      : NaN;

    pruneRecallSnapshots(db, {
      maxRecords:
        Number.isFinite(envMaxRecords) && envMaxRecords > 0
          ? envMaxRecords
          : DEFAULT_RECALL_MAX_RECORDS,
      maxBytes:
        Number.isFinite(envMaxBytes) && envMaxBytes > 0
          ? envMaxBytes
          : DEFAULT_RECALL_MAX_BYTES
    });
  } finally {
    db.close();
    ensureDbPermissions(dbPath);
  }
}

export type RecallLookupResult =
  | { kind: "found"; record: RecallRecord }
  | { kind: "not_found" }
  | { kind: "ambiguous"; matches: string[] };

export function lookupRecallRecord(
  env: NodeJS.ProcessEnv,
  idOrPrefix: string
): RecallLookupResult {
  const dbPath = resolveRecallDbPath(env);
  try {
    const db = openRecallDb(dbPath);
    try {
      const exact = db
        .prepare("SELECT * FROM recalls WHERE request_id = ?")
        .get(idOrPrefix) as RecallRecord | undefined;
      if (exact) {
        return { kind: "found", record: exact };
      }

      const escapedPrefix = idOrPrefix.replace(/[%_\\]/g, "\\$&");
      const matches = db
        .prepare(
          "SELECT * FROM recalls WHERE request_id LIKE ? || '%' ESCAPE '\\' ORDER BY timestamp DESC LIMIT 10"
        )
        .all(escapedPrefix) as RecallRecord[];

      if (matches.length === 0) {
        return { kind: "not_found" };
      }
      if (matches.length === 1) {
        return { kind: "found", record: matches[0] };
      }
      return {
        kind: "ambiguous",
        matches: matches.map((m) => m.request_id)
      };
    } finally {
      db.close();
    }
  } catch {
    return { kind: "not_found" };
  }
}

export function getRecallRecord(
  env: NodeJS.ProcessEnv,
  idOrPrefix: string
): RecallRecord | null {
  const result = lookupRecallRecord(env, idOrPrefix);
  return result.kind === "found" ? result.record : null;
}

export function getLatestRecallRecord(
  env: NodeJS.ProcessEnv = process.env
): RecallRecord | null {
  const dbPath = resolveRecallDbPath(env);
  try {
    const db = openRecallDb(dbPath);
    try {
      const row = db
        .prepare("SELECT * FROM recalls ORDER BY timestamp DESC LIMIT 1")
        .get() as RecallRecord | undefined;
      return row ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export function searchGrep(lines: string[], pattern: string): string[] {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  return lines.filter((line) => regex.test(line));
}

export function searchAround(
  lines: string[],
  pattern: string,
  contextLines: number = 20
): string {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }

  const hitIndices: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (regex.test(lines[i])) {
      hitIndices.push(i);
    }
  }

  if (hitIndices.length === 0) {
    return "";
  }

  const ranges: Array<[number, number]> = [];
  for (const hit of hitIndices) {
    const start = Math.max(0, hit - contextLines);
    const end = Math.min(lines.length - 1, hit + contextLines);
    if (ranges.length > 0 && ranges[ranges.length - 1][1] >= start - 1) {
      ranges[ranges.length - 1][1] = Math.max(ranges[ranges.length - 1][1], end);
    } else {
      ranges.push([start, end]);
    }
  }

  const chunks: string[] = [];
  for (const [start, end] of ranges) {
    chunks.push(lines.slice(start, end + 1).join("\n"));
  }

  return chunks.join("\n---\n");
}

export interface RecallCommandOptions {
  env?: NodeJS.ProcessEnv;
  stdout?: { write: (str: string) => void };
  stderr?: { write: (str: string) => void };
}

export async function runRecallCommand(
  args: string[],
  options: RecallCommandOptions = {}
): Promise<number> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  let requestId = "";
  let grepPattern: string | undefined;
  let aroundPattern: string | undefined;
  let contextLines = 20;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      stdout.write(
        "Usage: condense recall <id> [--grep <pattern>] [--around <pattern>] [-C <lines>]\n"
      );
      return 0;
    }

    if (arg === "--grep") {
      grepPattern = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--grep=")) {
      grepPattern = arg.slice("--grep=".length);
      continue;
    }

    if (arg === "--around") {
      aroundPattern = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--around=")) {
      aroundPattern = arg.slice("--around=".length);
      continue;
    }

    if (arg === "-C" || arg === "--context") {
      const parsed = parseInt(args[i + 1] ?? "", 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        contextLines = parsed;
      }
      i += 1;
      continue;
    }
    if (arg.startsWith("-C=")) {
      const parsed = parseInt(arg.slice("-C=".length), 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        contextLines = parsed;
      }
      continue;
    }
    if (arg.startsWith("--context=")) {
      const parsed = parseInt(arg.slice("--context=".length), 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        contextLines = parsed;
      }
      continue;
    }

    if (!requestId && !arg.startsWith("-")) {
      requestId = arg;
      continue;
    }

    stderr.write(`Unknown argument: ${arg}\n`);
    return 1;
  }

  if (!requestId) {
    stderr.write(
      "Usage: condense recall <id> [--grep <pattern>] [--around <pattern>] [-C <lines>]\n"
    );
    return 1;
  }

  const result = lookupRecallRecord(env, requestId);
  if (result.kind === "not_found") {
    stderr.write(`condense recall: record not found: ${requestId}\n`);
    return 1;
  }
  if (result.kind === "ambiguous") {
    stderr.write(
      `condense recall: prefix "${requestId}" is ambiguous (matches: ${result.matches.join(", ")}). Please specify a longer ID.\n`
    );
    return 1;
  }

  const record = result.record;

  const rawLines = record.raw_input.split("\n");

  if (aroundPattern) {
    const result = searchAround(rawLines, aroundPattern, contextLines);
    if (!result) {
      stderr.write(`(no matches found for pattern: ${aroundPattern})\n`);
      return 0;
    }
    stdout.write(`${result}\n`);
    return 0;
  }

  if (grepPattern) {
    const matches = searchGrep(rawLines, grepPattern);
    if (matches.length === 0) {
      stderr.write(`(no matches found for pattern: ${grepPattern})\n`);
      return 0;
    }
    stdout.write(`${matches.join("\n")}\n`);
    return 0;
  }

  stdout.write(record.raw_input.endsWith("\n") ? record.raw_input : `${record.raw_input}\n`);
  return 0;
}

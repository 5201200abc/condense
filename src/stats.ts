import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { UsageError } from "./config";
import { hashProjectPath } from "./dsl-memory";
import { withFileLock } from "./file-lock";
import { resolveConfigPath } from "./user-config";

export interface SingleRunStat {
  timestamp: string;
  projectHash: string;
  projectPath?: string;
  question?: string;
  inputChars: number;
  outputChars: number;
  savedChars: number;
  inputLines: number;
  outputLines: number;
  savedLines: number;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  durationMs: number;
  charCompressionRatio: number;
}

export interface MetricSummary {
  calls: number;
  inputChars: number;
  outputChars: number;
  savedChars: number;
  inputLines: number;
  outputLines: number;
  savedLines: number;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  durationMs: number;
}

export interface ProjectMetricSummary extends MetricSummary {
  projectPath?: string;
  recent?: SingleRunStat[];
  daily?: Record<string, MetricSummary>;
}

export interface StatsStorageFile {
  version: 1;
  totals: MetricSummary;
  byProject: Record<string, ProjectMetricSummary>;
  daily: Record<string, MetricSummary>;
  recent: SingleRunStat[];
  updatedAt: string;
}

export interface RecordCondenseRunOptions {
  cwd: string;
  question: string;
  rawInput: string;
  output: string;
  durationMs: number;
  now?: Date;
}

export interface FormatStatsOptions {
  projectHash?: string;
  projectPath?: string;
  days?: number;
  json?: boolean;
  history?: boolean;
  now?: Date;
}

export interface StatsCommandContext {
  env: NodeJS.ProcessEnv;
  cwd: string;
  now?: Date;
}

export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  const matches = text.match(/\w+|[^\w\s]|\s+/g);
  return matches ? matches.length : Math.ceil(text.length / 4);
}

function emptyMetricSummary(): MetricSummary {
  return {
    calls: 0,
    inputChars: 0,
    outputChars: 0,
    savedChars: 0,
    inputLines: 0,
    outputLines: 0,
    savedLines: 0,
    inputTokens: 0,
    outputTokens: 0,
    savedTokens: 0,
    durationMs: 0
  };
}

function emptyStatsStorage(now: Date = new Date()): StatsStorageFile {
  return {
    version: 1,
    totals: emptyMetricSummary(),
    byProject: {},
    daily: {},
    recent: [],
    updatedAt: now.toISOString()
  };
}

export function resolveStatsPath(env: NodeJS.ProcessEnv): string {
  const explicit = env.CONDENSE_STATS_PATH?.trim();

  if (explicit) {
    return explicit;
  }

  return path.join(path.dirname(resolveConfigPath(env)), "stats.json");
}

export function resolveStatsLockPath(env: NodeJS.ProcessEnv): string {
  return `${resolveStatsPath(env)}.lock`;
}

function normalizeRecent(entries: unknown): SingleRunStat[] {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries.map((entry) => {
    const item = entry as SingleRunStat;
    const inputChars = item.inputChars ?? 0;
    const outputChars = item.outputChars ?? 0;
    const inputTokens = item.inputTokens ?? Math.round(inputChars / 4);
    const outputTokens = item.outputTokens ?? Math.round(outputChars / 4);

    return {
      ...item,
      inputTokens,
      outputTokens,
      savedTokens: item.savedTokens ?? Math.max(0, inputTokens - outputTokens)
    };
  });
}

function normalizeDaily(
  daily: unknown
): Record<string, MetricSummary> {
  const next: Record<string, MetricSummary> = {};

  if (!daily || typeof daily !== "object") {
    return next;
  }

  for (const [key, val] of Object.entries(daily as Record<string, Partial<MetricSummary>>)) {
    next[key] = normalizeSummaryTokens(val);
  }

  return next;
}

function normalizeSummaryTokens(summary: Partial<MetricSummary>): MetricSummary {
  const calls = summary.calls ?? 0;
  const inputChars = summary.inputChars ?? 0;
  const outputChars = summary.outputChars ?? 0;
  const savedChars = summary.savedChars ?? 0;
  const inputLines = summary.inputLines ?? 0;
  const outputLines = summary.outputLines ?? 0;
  const savedLines = summary.savedLines ?? 0;
  const inputTokens = summary.inputTokens ?? Math.round(inputChars / 4);
  const outputTokens = summary.outputTokens ?? Math.round(outputChars / 4);
  const savedTokens = summary.savedTokens ?? Math.max(0, inputTokens - outputTokens);
  const durationMs = summary.durationMs ?? 0;

  return {
    calls,
    inputChars,
    outputChars,
    savedChars,
    inputLines,
    outputLines,
    savedLines,
    inputTokens,
    outputTokens,
    savedTokens,
    durationMs
  };
}

export async function readStatsFile(
  env: NodeJS.ProcessEnv,
  now: Date = new Date()
): Promise<StatsStorageFile> {
  const statsPath = resolveStatsPath(env);

  try {
    const raw = await readFile(statsPath, "utf8");
    const parsed = JSON.parse(raw) as StatsStorageFile;

    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) {
      return emptyStatsStorage(now);
    }

    const byProject: Record<string, ProjectMetricSummary> = {};
    if (parsed.byProject && typeof parsed.byProject === "object") {
      for (const [key, val] of Object.entries(parsed.byProject)) {
        byProject[key] = {
          ...normalizeSummaryTokens(val),
          projectPath: val.projectPath,
          recent: normalizeRecent(val.recent),
          daily: normalizeDaily(val.daily)
        };
      }
    }

    const daily = normalizeDaily(parsed.daily);
    const recent = normalizeRecent(parsed.recent);

    return {
      version: 1,
      totals: normalizeSummaryTokens(parsed.totals ?? {}),
      byProject,
      daily,
      recent,
      updatedAt: parsed.updatedAt ?? now.toISOString()
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyStatsStorage(now);
    }

    throw error;
  }
}

export async function writeStatsFile(
  env: NodeJS.ProcessEnv,
  stats: StatsStorageFile
): Promise<void> {
  const statsPath = resolveStatsPath(env);
  await mkdir(path.dirname(statsPath), { recursive: true, mode: 0o700 });
  await writeFile(statsPath, `${JSON.stringify(stats, null, 2)}\n`, { mode: 0o600 });
}

function countLines(text: string): number {
  if (!text) {
    return 0;
  }

  return text.split("\n").length;
}

function updateMetricSummary(
  target: MetricSummary,
  run: {
    inputChars: number;
    outputChars: number;
    savedChars: number;
    inputLines: number;
    outputLines: number;
    savedLines: number;
    inputTokens?: number;
    outputTokens?: number;
    savedTokens?: number;
    durationMs: number;
  }
): void {
  target.calls += 1;
  target.inputChars += run.inputChars;
  target.outputChars += run.outputChars;
  target.savedChars += run.savedChars;
  target.inputLines += run.inputLines;
  target.outputLines += run.outputLines;
  target.savedLines += run.savedLines;
  target.inputTokens += run.inputTokens ?? Math.round(run.inputChars / 4);
  target.outputTokens += run.outputTokens ?? Math.round(run.outputChars / 4);
  target.savedTokens +=
    run.savedTokens ??
    Math.max(0, (run.inputTokens ?? Math.round(run.inputChars / 4)) - (run.outputTokens ?? Math.round(run.outputChars / 4)));
  target.durationMs += run.durationMs;
}

function addMetricSummary(target: MetricSummary, source: MetricSummary): void {
  target.calls += source.calls;
  target.inputChars += source.inputChars;
  target.outputChars += source.outputChars;
  target.savedChars += source.savedChars;
  target.inputLines += source.inputLines;
  target.outputLines += source.outputLines;
  target.savedLines += source.savedLines;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.savedTokens += source.savedTokens;
  target.durationMs += source.durationMs;
}

function subtractMetricSummary(target: MetricSummary, source: MetricSummary): void {
  target.calls = Math.max(0, target.calls - source.calls);
  target.inputChars = Math.max(0, target.inputChars - source.inputChars);
  target.outputChars = Math.max(0, target.outputChars - source.outputChars);
  target.savedChars = Math.max(0, target.savedChars - source.savedChars);
  target.inputLines = Math.max(0, target.inputLines - source.inputLines);
  target.outputLines = Math.max(0, target.outputLines - source.outputLines);
  target.savedLines = Math.max(0, target.savedLines - source.savedLines);
  target.inputTokens = Math.max(0, target.inputTokens - source.inputTokens);
  target.outputTokens = Math.max(0, target.outputTokens - source.outputTokens);
  target.savedTokens = Math.max(0, target.savedTokens - source.savedTokens);
  target.durationMs = Math.max(0, target.durationMs - source.durationMs);
}

function resolveRunDescription(question?: string, rawInput?: string): string {
  const cleanQ = question?.trim();
  if (cleanQ && cleanQ.toLowerCase() !== "condense") {
    return cleanQ;
  }

  if (rawInput) {
    const lines = rawInput.trim().split("\n");
    for (const line of lines) {
      const cleanLine = line.trim();
      if (cleanLine.length > 0) {
        return cleanLine.length > 50 ? `${cleanLine.slice(0, 47)}...` : cleanLine;
      }
    }
  }

  return cleanQ || "pipeline command";
}

export async function recordCondenseRun(
  env: NodeJS.ProcessEnv,
  options: RecordCondenseRunOptions
): Promise<SingleRunStat> {
  return withFileLock(
    resolveStatsLockPath(env),
    async () => {
      const now = options.now ?? new Date();
      const inputChars = options.rawInput.length;
      const outputChars = options.output.length;
      const inputLines = countLines(options.rawInput);
      const outputLines = countLines(options.output);
      const savedChars = Math.max(0, inputChars - outputChars);
      const savedLines = Math.max(0, inputLines - outputLines);
      const inputTokens = estimateTokens(options.rawInput);
      const outputTokens = estimateTokens(options.output);
      const savedTokens = Math.max(0, inputTokens - outputTokens);
      const projectHash = hashProjectPath(options.cwd);
      const durationMs = Math.max(0, Math.round(options.durationMs));
      const charCompressionRatio =
        inputChars > 0 ? Number(((savedChars / inputChars) * 100).toFixed(2)) : 0;

      const runStat: SingleRunStat = {
        timestamp: now.toISOString(),
        projectHash,
        projectPath: options.cwd,
        question: resolveRunDescription(options.question, options.rawInput),
        inputChars,
        outputChars,
        savedChars,
        inputLines,
        outputLines,
        savedLines,
        inputTokens,
        outputTokens,
        savedTokens,
        durationMs,
        charCompressionRatio
      };

      const stats = await readStatsFile(env, now);
      const dateKey = now.toISOString().slice(0, 10);

      updateMetricSummary(stats.totals, runStat);

      if (!stats.byProject[projectHash]) {
        stats.byProject[projectHash] = {
          ...emptyMetricSummary(),
          projectPath: options.cwd,
          recent: [],
          daily: {}
        };
      }
      const project = stats.byProject[projectHash];
      updateMetricSummary(project, runStat);
      project.projectPath = options.cwd;
      if (!Array.isArray(project.recent)) {
        project.recent = [];
      }
      project.recent.unshift(runStat);
      if (project.recent.length > 50) {
        project.recent = project.recent.slice(0, 50);
      }
      if (!project.daily) {
        project.daily = {};
      }
      if (!project.daily[dateKey]) {
        project.daily[dateKey] = emptyMetricSummary();
      }
      updateMetricSummary(project.daily[dateKey], runStat);

      if (!stats.daily[dateKey]) {
        stats.daily[dateKey] = emptyMetricSummary();
      }
      updateMetricSummary(stats.daily[dateKey], runStat);

      stats.recent.unshift(runStat);
      if (stats.recent.length > 200) {
        stats.recent = stats.recent.slice(0, 200);
      }

      stats.updatedAt = now.toISOString();
      await writeStatsFile(env, stats);

      return runStat;
    },
    { timeoutMs: 10_000 }
  );
}

export async function resetStats(
  env: NodeJS.ProcessEnv,
  options: { projectHash?: string } = {}
): Promise<string> {
  return withFileLock(
    resolveStatsLockPath(env),
    async () => {
      const statsPath = resolveStatsPath(env);

      if (!options.projectHash) {
        await rm(statsPath, { force: true });
        return "Global character savings stats reset successfully.\n";
      }

      const stats = await readStatsFile(env);
      const project = stats.byProject[options.projectHash];

      if (!project) {
        return `No stats found for project ${options.projectHash}.\n`;
      }

      subtractMetricSummary(stats.totals, project);

      for (const [dayKey, dayStat] of Object.entries(project.daily ?? {})) {
        if (!stats.daily[dayKey]) {
          continue;
        }

        subtractMetricSummary(stats.daily[dayKey], dayStat);

        if (stats.daily[dayKey].calls <= 0) {
          delete stats.daily[dayKey];
        }
      }

      delete stats.byProject[options.projectHash];
      stats.recent = stats.recent.filter(
        (entry) => entry.projectHash !== options.projectHash
      );
      await writeStatsFile(env, stats);
      return `Character savings stats reset for project ${options.projectHash}.\n`;
    },
    { timeoutMs: 10_000 }
  );
}

export function formatSingleRunSummary(stat: SingleRunStat): string {
  return `[condense] ${stat.inputChars.toLocaleString()} chars -> ${stat.outputChars.toLocaleString()} chars (${stat.charCompressionRatio.toFixed(1)}% chars saved, ${stat.durationMs}ms)`;
}

function calculatePercentage(saved: number, total: number): string {
  if (total <= 0) {
    return "0.00%";
  }
  return `${((saved / total) * 100).toFixed(2)}%`;
}

function formatHistoryTimestamp(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return "00-00 00:00";
  }
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hours}:${minutes}`;
}

function formatRecentCommands(runs: SingleRunStat[], maxCount: number = 20): string[] {
  if (runs.length === 0) {
    return [];
  }

  const lines: string[] = [];
  lines.push("");
  lines.push("Condense Recent Commands");
  lines.push("------------------------------------------------------------");

  const items = runs.slice(0, maxCount);
  for (const run of items) {
    const timeStr = formatHistoryTimestamp(run.timestamp);
    const rawDesc =
      run.question && run.question !== "condense"
        ? run.question.trim()
        : "pipeline command";
    const truncatedDesc =
      rawDesc.length > 36 ? `${rawDesc.slice(0, 33)}...` : rawDesc;
    const ratioStr = `-${run.charCompressionRatio.toFixed(0)}%`;
    const savedStr = `(${run.savedChars.toLocaleString()} chars)`;

    lines.push(
      `${timeStr}  ${truncatedDesc.padEnd(38)} ${ratioStr.padStart(5)} ${savedStr}`
    );
  }

  return lines;
}

export function formatStatsReport(
  stats: StatsStorageFile,
  options: FormatStatsOptions = {}
): string {
  let targetSummary = stats.totals;
  let scopeLabel = "Global";

  if (options.projectHash) {
    targetSummary = stats.byProject[options.projectHash] ?? emptyMetricSummary();
    const displayPath =
      targetSummary.projectPath ?? options.projectPath ?? options.projectHash;
    scopeLabel = `Project: ${displayPath}`;
  }

  let recentRuns = stats.recent;
  if (options.projectHash) {
    const projectSummary = stats.byProject[options.projectHash];
    recentRuns =
      projectSummary?.recent && projectSummary.recent.length > 0
        ? projectSummary.recent
        : stats.recent.filter((entry) => entry.projectHash === options.projectHash);
  }

  if (options.days && options.days > 0) {
    const now = options.now ?? new Date();
    const cutoffDate = new Date(now.getTime());
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - options.days);
    const cutoffKey = cutoffDate.toISOString().slice(0, 10);
    const cutoffIso = cutoffDate.toISOString();

    const dailySource = options.projectHash
      ? stats.byProject[options.projectHash]?.daily &&
        Object.keys(stats.byProject[options.projectHash]?.daily ?? {}).length > 0
        ? stats.byProject[options.projectHash].daily ?? {}
        : (() => {
            const reconstructed: Record<string, MetricSummary> = {};
            for (const run of recentRuns) {
              const dayKey = run.timestamp.slice(0, 10);
              if (!reconstructed[dayKey]) {
                reconstructed[dayKey] = emptyMetricSummary();
              }
              updateMetricSummary(reconstructed[dayKey], run);
            }
            return reconstructed;
          })()
      : stats.daily;

    const filteredSummary = emptyMetricSummary();
    for (const [dayKey, dayStat] of Object.entries(dailySource)) {
      if (dayKey >= cutoffKey) {
        addMetricSummary(filteredSummary, dayStat);
      }
    }
    targetSummary = filteredSummary;
    scopeLabel = `${scopeLabel} (Last ${options.days} days)`;
    recentRuns = recentRuns.filter((entry) => entry.timestamp >= cutoffIso);
  }

  if (options.json) {
    const charCompressionRatio =
      targetSummary.inputChars > 0
        ? Number(((targetSummary.savedChars / targetSummary.inputChars) * 100).toFixed(2))
        : 0;
    const lineCompressionRatio =
      targetSummary.inputLines > 0
        ? Number(((targetSummary.savedLines / targetSummary.inputLines) * 100).toFixed(2))
        : 0;
    const tokenCompressionRatio =
      targetSummary.inputTokens > 0
        ? Number(((targetSummary.savedTokens / targetSummary.inputTokens) * 100).toFixed(2))
        : 0;
    const avgDurationMs =
      targetSummary.calls > 0
        ? Math.round(targetSummary.durationMs / targetSummary.calls)
        : 0;

    return `${JSON.stringify(
      {
        scope: scopeLabel,
        summary: {
          ...targetSummary,
          charCompressionRatio,
          lineCompressionRatio,
          tokenCompressionRatio,
          avgDurationMs
        },
        byProject: stats.byProject,
        daily: stats.daily,
        recent: recentRuns
      },
      null,
      2
    )}\n`;
  }

  const lines: string[] = [];
  lines.push(`Condense Character Savings Summary (${scopeLabel})`);
  lines.push("============================================================");

  if (targetSummary.calls === 0) {
    lines.push("No condense runs recorded yet.");
    lines.push("============================================================");
    return `${lines.join("\n")}\n`;
  }

  const avgDurationMs = Math.round(targetSummary.durationMs / targetSummary.calls);
  const savedTokens =
    targetSummary.savedTokens ?? Math.round((targetSummary.savedChars ?? 0) / 4);
  const inputTokens =
    targetSummary.inputTokens ?? Math.round((targetSummary.inputChars ?? 0) / 4);
  const tokenRatio = calculatePercentage(savedTokens, inputTokens);
  const charRatio = calculatePercentage(targetSummary.savedChars, targetSummary.inputChars);
  const lineRatio = calculatePercentage(targetSummary.savedLines, targetSummary.inputLines);

  lines.push(`Tokens Saved           : ${savedTokens.toLocaleString()} tokens (${tokenRatio})`);
  lines.push(`Total Executions       : ${targetSummary.calls.toLocaleString()} calls`);
  lines.push(
    `Raw Input Processed    : ${targetSummary.inputLines.toLocaleString()} lines (${targetSummary.inputChars.toLocaleString()} chars)`
  );
  lines.push(
    `Condensed Output       : ${targetSummary.outputLines.toLocaleString()} lines (${targetSummary.outputChars.toLocaleString()} chars)`
  );
  lines.push("------------------------------------------------------------");
  lines.push(`Chars Saved            : ${targetSummary.savedChars.toLocaleString()} chars (${charRatio})`);
  lines.push(`Lines Saved            : ${targetSummary.savedLines.toLocaleString()} lines (${lineRatio})`);
  lines.push(`Avg Latency            : ${avgDurationMs} ms`);
  lines.push("============================================================");

  const historyLimit = options.history ? 50 : 10;
  const historyLines = formatRecentCommands(recentRuns, historyLimit);
  if (historyLines.length > 0) {
    lines.push(...historyLines);
  }

  return `${lines.join("\n")}\n`;
}

export async function runStatsCommand(
  args: string[],
  context: StatsCommandContext
): Promise<string> {
  const now = context.now ?? new Date();
  let project = false;
  let json = false;
  let reset = false;
  let history = false;
  let days: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--project" || arg === "-p") {
      project = true;
      continue;
    }

    if (arg === "-H" || arg === "--history") {
      history = true;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--reset" || arg === "reset") {
      reset = true;
      continue;
    }

    if (arg === "--days" || arg === "-d") {
      const next = args[index + 1];
      if (!next) {
        throw new UsageError("Missing value for --days.");
      }
      const parsedDays = Number(next);
      if (!Number.isInteger(parsedDays) || parsedDays <= 0) {
        throw new UsageError("--days must be a positive integer.");
      }
      days = parsedDays;
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new UsageError(`Unknown stats flag: ${arg}`);
    }

    throw new UsageError(`Unexpected argument for stats: ${arg}`);
  }

  const projectHash = project ? hashProjectPath(context.cwd) : undefined;

  if (reset) {
    return resetStats(context.env, { projectHash });
  }

  const stats = await readStatsFile(context.env, now);
  return formatStatsReport(stats, {
    projectHash,
    projectPath: context.cwd,
    days,
    json,
    history,
    now
  });
}

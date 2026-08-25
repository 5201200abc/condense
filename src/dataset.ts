import { mkdir, open, stat } from "node:fs/promises";
import path from "node:path";

import type { RuntimeConfig } from "./config";
import { buildBatchPrompt } from "./prompt";
import { resolveConfigPath } from "./user-config";

export const INSUFFICIENT_OUTPUT =
  "condense: Insufficient information to output anything.";

export type DatasetTask =
  | "test_result"
  | "typescript_check"
  | "terraform_plan"
  | "security_audit"
  | "json_extraction"
  | "pass_fail"
  | "safe_review"
  | "generic";

export type DatasetRisk = "low" | "medium" | "high";

export interface DatasetRecord {
  prompt: string;
  completion: string;
  metadata: {
    source: "condense";
    task: DatasetTask;
    risk: DatasetRisk;
    mode: "batch";
    created_at: string;
  };
}

export interface DatasetAppendConfig {
  enabled: boolean;
  path: string;
}

export function resolveDatasetPath(
  env: NodeJS.ProcessEnv,
  configuredPath?: string
): string {
  const explicit = configuredPath?.trim();

  if (explicit) {
    return explicit;
  }

  return path.join(path.dirname(resolveConfigPath(env)), "datasets", "condense.jsonl");
}

export function buildDatasetPrompt(
  contract: string,
  task: DatasetTask,
  question: string,
  input: string
): string {
  return [
    contract.trim(),
    "",
    "TASK:",
    task,
    "",
    "QUESTION:",
    question,
    "",
    "INPUT:",
    input
  ].join("\n");
}

export function inferDatasetTask(question: string): DatasetTask {
  const normalized = question.toLowerCase();

  if (/\b(json|valid json|extract)\b/.test(normalized)) {
    return "json_extraction";
  }

  if (/\b(terraform|tf plan|plan output)\b/.test(normalized)) {
    return "terraform_plan";
  }

  if (/\b(security|vulnerab|cve|audit|npm audit|risk)\b/.test(normalized)) {
    return "security_audit";
  }

  if (/\b(typescript|tsc|ts\d{4})\b/.test(normalized)) {
    return "typescript_check";
  }

  if (/\b(test|tests|spec|jest|vitest|bun test|pytest|rspec)\b/.test(normalized)) {
    return "test_result";
  }

  if (/\b(safe|review|unsafe)\b/.test(normalized)) {
    return "safe_review";
  }

  if (/\b(pass|fail)\b/.test(normalized)) {
    return "pass_fail";
  }

  return "generic";
}

export function inferDatasetRisk(
  question: string,
  task: DatasetTask
): DatasetRisk {
  const normalized = question.toLowerCase();

  if (
    task === "terraform_plan" ||
    task === "security_audit" ||
    /\b(delete|destroy|drop|truncate|cancel|rm -rf|force|secret|credential|prod|production|migration)\b/.test(
      normalized
    )
  ) {
    return "high";
  }

  if (/\b(deploy|release|ci|pipeline|infra|rollback)\b/.test(normalized)) {
    return "medium";
  }

  return "low";
}

export function buildDatasetRecord(
  config: RuntimeConfig,
  input: string,
  completion: string,
  createdAt: Date = new Date()
): DatasetRecord {
  const task = inferDatasetTask(config.question);
  const contract = buildBatchPrompt(config.question, input).system;

  return {
    prompt: buildDatasetPrompt(contract, task, config.question, input),
    completion,
    metadata: {
      source: "condense",
      task,
      risk: inferDatasetRisk(config.question, task),
      mode: "batch",
      created_at: createdAt.toISOString()
    }
  };
}

export interface DatasetAppendResult {
  written: boolean;
  firstWrite: boolean;
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

export async function appendDatasetRecord(
  config: DatasetAppendConfig,
  record: DatasetRecord
): Promise<DatasetAppendResult> {
  if (!config.enabled) {
    return { written: false, firstWrite: false };
  }

  await mkdir(path.dirname(config.path), { recursive: true, mode: 0o700 });
  const firstWrite = !(await fileExists(config.path));
  const handle = await open(config.path, "a", 0o600);

  try {
    await handle.appendFile(`${JSON.stringify(record)}\n`, "utf8");
  } finally {
    await handle.close();
  }

  return { written: true, firstWrite };
}

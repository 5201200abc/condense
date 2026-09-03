import {
  CONDENSE_VERSION,
  UsageError,
  formatUsage,
  parseCommand,
  resolveRuntimeDefaults
} from "./config";
import { stdinIsTTY, stdoutIsTTY, stderrIsTTY } from "./tty";
import {
  formatPromptDslMemory,
  learnFromCondenseOutput,
  readMergedDslMemory,
  runDslCommand,
  type DslPromotionReview,
  type DslThreadLearnReview
} from "./dsl-memory";
import {
  summarizeBatch,
  summarizeDslPromotion,
  summarizeThreadLearn,
  summarizeTranslate,
  summarizeWatch
} from "./llm";
import { runOnboarding, warmupLocalModel } from "./onboarding";
import { runStatsCommand } from "./stats";
import { CondenseSession, type ProgressPhase } from "./stream-condenser";
import { resolveDatasetPath } from "./dataset";
import {
  getPersistedConfigValue,
  readPersistedConfig,
  resolveConfigPath,
  setPersistedConfigValue
} from "./user-config";

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new UsageError("stdin is required.");
  }

  const chunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    process.stdin.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    process.stdin.on("end", resolve);
    process.stdin.on("error", reject);
    process.stdin.resume();
  });

  return Buffer.concat(chunks).toString("utf8");
}

export async function runUpgradeCommand(): Promise<string> {
  const currentVersion = CONDENSE_VERSION;
  let latestVersion = "";

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(
      "https://api.github.com/repos/5201200abc/condense/releases/latest",
      {
        headers: { "User-Agent": `condense/${currentVersion}` },
        signal: controller.signal
      }
    );
    clearTimeout(timer);

    if (res.ok) {
      const data = (await res.json()) as { tag_name?: string };
      latestVersion = (data.tag_name ?? "").replace(/^v/, "").trim();
    }
  } catch {
    // ignore network errors
  }

  const lines: string[] = [];
  lines.push(`Current version: v${currentVersion}`);

  if (latestVersion && latestVersion !== currentVersion) {
    lines.push(`Latest version : v${latestVersion}`);
    lines.push("");
    lines.push("To upgrade condense, run:");
    lines.push("  curl -fsSL https://raw.githubusercontent.com/5201200abc/condense/main/install.sh | sh");
    lines.push("");
    lines.push("Or via npm:");
    lines.push("  npm install -g condense@latest");
  } else {
    lines.push("condense is up to date.");
  }

  return lines.join("\n") + "\n";
}

async function run(): Promise<number> {
  const persisted = await readPersistedConfig(process.env);
  const command = parseCommand(process.argv.slice(2), process.env, persisted, {
    stdinIsTTY: stdinIsTTY()
  });

  if (command.kind === "onboard") {
    await runOnboarding({ env: process.env, persisted });
    return 0;
  }

  if (command.kind === "warmup") {
    await warmupLocalModel({ env: process.env, persisted });
    return 0;
  }

  if (command.kind === "help") {
    process.stdout.write(`${formatUsage()}\n`);
    return 0;
  }

  if (command.kind === "version") {
    process.stdout.write(`${CONDENSE_VERSION}\n`);
    return 0;
  }

  if (command.kind === "upgrade") {
    process.stdout.write(await runUpgradeCommand());
    return 0;
  }

  if (command.kind === "dsl") {
    const defaults = resolveRuntimeDefaults(process.env, persisted);
    const runtimeConfig = {
      question: "Review DSL memory.",
      provider: defaults.provider,
      localBackend: defaults.localBackend,
      localConcurrency: defaults.localConcurrency,
      localHost: defaults.localHost,
      localPort: defaults.localPort,
      model: defaults.model,
      host: defaults.host,
      apiKey: defaults.apiKey,
      timeoutMs: defaults.timeoutMs,
      datasetEnabled: defaults.datasetEnabled,
      datasetPath: defaults.datasetPath,
      autoLearn: defaults.autoLearn,
      autoLearnScope: defaults.autoLearnScope,
      autoLearnSource: defaults.autoLearnSource,
      autoPromoteScopes: defaults.autoPromoteScopes,
      maxPromptDslEntries: defaults.maxPromptDslEntries
    };
    process.stdout.write(
      await runDslCommand(command.args, {
        env: process.env,
        cwd: process.cwd(),
        readStdin: readAllStdin,
        promotionReviewer: async (entries) => {
          const response = await summarizeDslPromotion(
            { ...runtimeConfig, question: "Review DSL promotion candidates." },
            entries
              .map(
                (entry) =>
                  `${entry.key}\t${entry.kind}\t${entry.meaning}\tuses=${entry.useCount}`
              )
              .join("\n")
          );

          return JSON.parse(response) as DslPromotionReview[];
        },
        threadLearnReviewer: async (request) => {
          const dslMemory = formatPromptDslMemory(
            request.dslMemory,
            defaults.maxPromptDslEntries ?? 40
          );
          const response = await summarizeThreadLearn(
            { ...runtimeConfig, question: "Review thread DSL candidates." },
            request.transcript,
            request.candidates,
            dslMemory
          );

          return JSON.parse(response) as DslThreadLearnReview[];
        }
      })
    );
    return 0;
  }

  if (command.kind === "stats") {
    process.stdout.write(
      await runStatsCommand(command.args, {
        env: process.env,
        cwd: process.cwd()
      })
    );
    return 0;
  }

  if (command.kind === "configShow") {
    process.stdout.write(
      [
        `path=${resolveConfigPath(process.env)}`,
        `provider=${persisted.provider ?? ""}`,
        `local-backend=${persisted.localBackend ?? ""}`,
        `local-concurrency=${persisted.localConcurrency ?? ""}`,
        `local-host=${persisted.localHost ?? ""}`,
        `local-port=${persisted.localPort ?? ""}`,
        `model=${persisted.model ?? ""}`,
        `host=${persisted.host ?? ""}`,
        `api-key=${persisted.apiKey ? "***" : ""}`,
        `timeout-ms=${persisted.timeoutMs ?? ""}`,
        `dataset-enabled=${persisted.datasetEnabled ?? ""}`,
        `dataset-path=${persisted.datasetPath ?? ""}`,
        `auto-learn=${persisted.autoLearn ?? ""}`,
        `auto-promote-scopes=${persisted.autoPromoteScopes ?? ""}`,
        `max-prompt-dsl-entries=${persisted.maxPromptDslEntries ?? ""}`
      ].join("\n") + "\n"
    );
    return 0;
  }

  if (command.kind === "configGet") {
    const value = getPersistedConfigValue(persisted, command.key);
    process.stdout.write(`${value ?? ""}\n`);
    return 0;
  }

  if (command.kind === "configSet") {
    await setPersistedConfigValue(process.env, command.key, command.value);
    process.stdout.write(`${command.key}=${String(command.value)}\n`);
    return 0;
  }

  if (command.kind === "translate") {
    const output = await summarizeTranslate(
      command.config,
      command.text,
      command.language
    );
    process.stdout.write(`${output}\n`);
    return 0;
  }

  if (process.stdin.isTTY) {
    throw new UsageError("stdin is required.");
  }

  const progressProtocol = process.env.CONDENSE_PROGRESS_PROTOCOL === "stderr";
  const mergedDslMemory = await readMergedDslMemory(
    process.env,
    process.cwd(),
    undefined
  );
  const promptDslMemory = formatPromptDslMemory(
    mergedDslMemory,
    command.config.maxPromptDslEntries ?? 40
  );
  const progress = progressProtocol
    ? undefined
    : stderrIsTTY()
      ? process.stderr
      : stdoutIsTTY()
        ? process.stdout
        : undefined;
  const emitProgressPhase = progressProtocol
    ? (phase: ProgressPhase) => {
        process.stderr.write(`__CONDENSE_PROGRESS__:phase:${phase}\n`);
      }
    : undefined;
  const emitProgressStop = progressProtocol
    ? () => {
        process.stderr.write("__CONDENSE_PROGRESS__:stop\n");
      }
    : undefined;
  const session = new CondenseSession({
    summarizer: {
      summarizeBatch: (input) =>
        summarizeBatch(command.config, input, { dslMemory: promptDslMemory }),
      summarizeWatch: (previous, current) =>
        summarizeWatch(command.config, previous, current)
    },
    runtimeConfig: command.config,
    dataset: {
      enabled: command.config.datasetEnabled,
      path: resolveDatasetPath(process.env, command.config.datasetPath)
    },
    stdout: process.stdout,
    stderr: process.stderr,
    isTTY: stdoutIsTTY(),
    progress,
    onProgressPhase: emitProgressPhase,
    onProgressStop: emitProgressStop,
    onBatchOutput: command.config.autoLearn !== false
      ? (output) =>
          learnFromCondenseOutput(process.env, process.cwd(), output, {
            stack: undefined
          }).then(() => undefined)
      : undefined
  });

  await new Promise<void>((resolve, reject) => {
    process.stdin.on("data", (chunk) => {
      session.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    process.stdin.on("end", resolve);
    process.stdin.on("error", reject);
    process.stdin.resume();
  });

  await session.end();
  return 0;
}

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${formatUsage()}\n`);
      process.exit(error.exitCode);
    }

    process.stderr.write(
      error instanceof Error ? `${error.message}\n` : "Unexpected error.\n"
    );
    process.exit(1);
  });

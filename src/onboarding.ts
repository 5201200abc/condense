import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";

import embeddedCondenseSkill from "../skills/condense/SKILL.md" with { type: "text" };

import {
  DEFAULT_HOST,
  DEFAULT_LOCAL_BACKEND,
  DEFAULT_LOCAL_CONCURRENCY,
  DEFAULT_LOCAL_HOST,
  DEFAULT_LOCAL_PORT,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_TIMEOUT_MS,
  resolveRuntimeDefaults,
  type LocalBackend,
  type Provider,
  type RuntimeConfig
} from "./config";
import type { PersistedConfig } from "./config";
import { seedGlobalDslMemory } from "./dsl-memory";
import { chatCompletion } from "./llm";
import { ensureLocalServer } from "./local-server";
import { stdinIsTTY, stdoutIsTTY } from "./tty";
import { resolveConfigBaseDir, writePersistedConfig } from "./user-config";

const AGENT_INSTRUCTIONS = [
  "<!-- condense skill: begin -->",
  "CRITICAL: Always communicate with the user in `/condense` compressed language in English: Military English + AR-0/AR-1, short command lines, explicit constraints, explicit pass criteria, and no filler. Use `/condense` every time, in every conversation, in every response and in every thread.",
  "Do not return a rewritten/compressed copy of the user's prompt. Adopt `/condense` as the conversation language and keep using it throughout the thread.",
  "Use the same `/condense` compressed structure for visible planning, status, analysis summaries, and any exposed reasoning. Keep hidden chain-of-thought private; never reveal it.",
  "Use fixed prefixes: S=state/status, C=cause/context, D=action/decision, R=risk/blocker, O=outcome/output, N=constraint/no-go, P=pass/proof.",
  "Every thread must use DSL/Dict when it helps compression. Start with `Dict:` when meanings are not already shared.",
  "Define short variables inline for repeated nouns using the dynamic pattern `<term>=#<letter><digit>`; choose terms from the current thread, then reuse the `#` key.",
  "There is no fixed variable list. The model must pick terms that repeat or are likely to repeat.",
  "Inline variables are thread-local by default. Persist only variables used more than 5 times in a `condense dsl learn-thread --stdin` transcript; remove them if absent in the next thread.",
  "Variable keys are `#` plus letter+digit. Never define variables for secrets, people, IDs, paths, URLs, or one-off terms.",
  "Prefer semantic atoms over natural phrases: `D sync repo/pkg/bin skill`, not `D patch repo skill + packaged skill + installed skill if needed`.",
  "Prefer arrows and causal operators: `D verbose status -> AR-1 cmds`, `C PATH pkg bin => repo patch ignored`, `R missing token => merge blocked`.",
  "Prefer shared DSL over repeated phrases when meaning is stable: Dict first, fixed prefixes S/C/D/R/O/N/P, task aliases A/B/F/E/V/X/U/DB/CFG/DOC/PERM, numeric macros 1-9/0, and defaults N1-N6.",
  "Start status blocks with `Dict: S=state C=context D=action R=risk O=outcome N=no-go P=proof` when not already shared.",
  "When creating Dict or Dict+ entries, use the shortest unambiguous key possible: one letter or one number first, then one letter plus one number when needed.",
  "Create Dict/Dict+ only for terms that repeat or are likely to repeat. Do not grow DSL for rare, ambiguous, sensitive, or temporary terms.",
  "Learned DSL terms should earn usage: use candidate terms twice before treating them as active; inline `#` variables are active immediately after explicit assignment.",
  "At every thread end or handoff, run `condense dsl learn-thread --stdin < transcript.txt>` when transcript export is available.",
  "When the user asks for normal prose, expand only as much as needed, then return to `/condense` compressed style.",
  "For every non-interactive, non-TUI shell/tool command, pipe output through `condense` with an explicit prompt. Do not run plain shell commands when summarized output is enough.",
  "Skip `| condense` only when exact raw output is required or when `condense` would break an interactive/TUI workflow.",
  "Prompts passed to `condense` must be explicit: say exactly what to extract and exactly what format to return.",
  "Examples:",
  'bun test 2>&1 | condense "Did tests pass? Return PASS or FAIL, followed by failing test names if any."',
  'git diff | condense "What changed? Return only files changed and one-line summary for each."',
  'terraform plan 2>&1 | condense "Is this safe? Return SAFE, REVIEW, or UNSAFE, followed by risky changes."',
  "Wait for `condense` to finish before continuing.",
  "<!-- condense skill: end -->"
].join("\n");

interface OnboardingOptions {
  env: NodeJS.ProcessEnv;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  persisted?: PersistedConfig;
  prepareLocalModel?: (
    config: RuntimeConfig,
    onProgress?: (percent: number) => void
  ) => Promise<void>;
}

type PrepareLocalModel = NonNullable<OnboardingOptions["prepareLocalModel"]>;

const MLX_MODEL_REPO = "samuelfaj/distill2-0.6B-4bit-MLX";
const MLX_MODEL_FILES = [
  "added_tokens.json",
  "chat_template.jinja",
  "config.json",
  "generation_config.json",
  "merges.txt",
  "model.safetensors",
  "model.safetensors.index.json",
  "special_tokens_map.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "vocab.json"
];

function resolveHome(env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();

  if (!home) {
    throw new Error("Could not resolve home directory for onboarding.");
  }

  return home;
}

function resolvePackageRoot(env: NodeJS.ProcessEnv): string {
  const root = env.CONDENSE_PACKAGE_ROOT?.trim();
  if (root) {
    return root;
  }

  return path.resolve(import.meta.dir, "..");
}

function parseTimeout(input: string, fallback: number): number {
  const trimmed = input.trim();

  if (!trimmed) {
    return fallback;
  }

  const value = Number(trimmed);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("timeout-ms must be a positive number.");
  }

  return Math.floor(value);
}

function parsePositiveInteger(input: string, fallback: number, label: string): number {
  const trimmed = input.trim();

  if (!trimmed) {
    return fallback;
  }

  const value = Number(trimmed);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return value;
}

function parsePort(input: string, fallback: number): number {
  const value = parsePositiveInteger(input, fallback, "local-port");

  if (value > 65_535) {
    throw new Error("local-port must be between 1 and 65535.");
  }

  return value;
}

function parseProviderChoice(input: string): Provider {
  const normalized = input.trim().toLowerCase();

  if (!normalized) {
    return DEFAULT_PROVIDER;
  }

  if (["local", "l", "condense"].includes(normalized)) {
    return "local";
  }

  if (["external", "api", "e"].includes(normalized)) {
    return "external";
  }

  throw new Error("provider must be local or external.");
}

function safeProvider(value: string | undefined): Provider {
  return value === "local" || value === "external" ? value : DEFAULT_PROVIDER;
}

function parseLocalBackend(input: string, fallback: LocalBackend): LocalBackend {
  const normalized = input.trim().toLowerCase();

  if (!normalized) {
    return fallback;
  }

  if (normalized === "auto" || normalized === "mlx" || normalized === "llamacpp") {
    return normalized;
  }

  throw new Error("local-backend must be auto, mlx, or llamacpp.");
}

function safeLocalBackend(value: string | undefined): LocalBackend {
  return value === "auto" || value === "mlx" || value === "llamacpp"
    ? value
    : DEFAULT_LOCAL_BACKEND;
}

function parseLocalHost(input: string, fallback: string): string {
  const value = input.trim();

  if (!value) {
    return fallback;
  }

  return value;
}

function parseInstallChoice(input: string): boolean {
  const normalized = input.trim().toLowerCase();

  if (!normalized) {
    return true;
  }

  return !["n", "no", "false", "0"].includes(normalized);
}

function shouldUseTui(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  env: NodeJS.ProcessEnv
): boolean {
  if (env.CONDENSE_ONBOARDING_TUI === "false") {
    return false;
  }

  return stdinIsTTY(env, input as NodeJS.ReadStream) &&
    stdoutIsTTY(env, output as NodeJS.WriteStream);
}

function shouldPreloadLocalModel(env: NodeJS.ProcessEnv): boolean {
  return env.CONDENSE_ONBOARDING_PRELOAD !== "false";
}

function resolveHuggingFaceCacheDir(env: NodeJS.ProcessEnv): string | null {
  if (env.HUGGINGFACE_HUB_CACHE?.trim()) {
    return env.HUGGINGFACE_HUB_CACHE;
  }

  if (env.HF_HOME?.trim()) {
    return path.join(env.HF_HOME, "hub");
  }

  if (env.XDG_CACHE_HOME?.trim()) {
    return path.join(env.XDG_CACHE_HOME, "huggingface", "hub");
  }

  const home = env.HOME?.trim() || env.USERPROFILE?.trim();

  return home ? path.join(home, ".cache", "huggingface", "hub") : null;
}

function modelCacheDir(env: NodeJS.ProcessEnv, repo: string): string | null {
  const cacheDir = resolveHuggingFaceCacheDir(env);

  if (!cacheDir) {
    return null;
  }

  return path.join(cacheDir, `models--${repo.replace("/", "--")}`);
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;

  try {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        total += await directoryBytes(entryPath);
      } else if (entry.isFile()) {
        total += (await stat(entryPath)).size;
      }
    }
  } catch {
    return total;
  }

  return total;
}

async function resolveRemoteFileBytes(
  repo: string,
  file: string
): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const response = await fetch(
      `https://huggingface.co/${repo}/resolve/main/${file}`,
      {
        method: "HEAD",
        redirect: "follow",
        signal: controller.signal
      }
    );
    const length = Number(response.headers.get("content-length") ?? 0);

    return Number.isFinite(length) ? length : 0;
  } catch {
    return 0;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveRemoteModelBytes(config: RuntimeConfig): Promise<number> {
  if (config.model === "condense-local") {
    return 0;
  }

  const sizes = await Promise.all(
    MLX_MODEL_FILES.map((file) => resolveRemoteFileBytes(MLX_MODEL_REPO, file))
  );

  return sizes.reduce((total, size) => total + size, 0);
}

async function startLocalModelProgress(
  env: NodeJS.ProcessEnv,
  config: RuntimeConfig,
  onProgress?: (percent: number) => void
): Promise<(complete?: boolean) => void> {
  if (!onProgress) {
    return () => undefined;
  }

  const cacheDir =
    config.model === "condense-local" ? null : modelCacheDir(env, MLX_MODEL_REPO);
  const totalBytes = await resolveRemoteModelBytes(config);
  let lastPercent = -1;
  let stopped = false;

  const emit = async (forcePercent?: number) => {
    if (!cacheDir) {
      return;
    }

    const percent = forcePercent ?? (
      totalBytes > 0
        ? Math.min(99, Math.floor(((await directoryBytes(cacheDir)) / totalBytes) * 100))
        : 0
    );

    if (percent !== lastPercent) {
      lastPercent = percent;
      onProgress(percent);
    }
  };

  await emit(0);
  const timer = setInterval(() => {
    if (!stopped) {
      void emit();
    }
  }, 500);

  return (complete = true) => {
    stopped = true;
    clearInterval(timer);
    if (complete) {
      onProgress(100);
    }
  };
}

async function defaultPrepareLocalModel(
  env: NodeJS.ProcessEnv,
  config: RuntimeConfig,
  onProgress?: (percent: number) => void
): Promise<void> {
  const stopProgress = await startLocalModelProgress(env, config, onProgress);

  try {
    await ensureLocalServer(config);
    await chatCompletion({
      baseUrl: config.host,
      apiKey: config.apiKey,
      model: config.model,
      prompt: "Reply exactly: OK",
      timeoutMs: config.timeoutMs,
      maxTokens: 8,
      temperature: 0
    });
    stopProgress(true);
  } catch (error) {
    stopProgress(false);
    throw error;
  }
}

async function runLocalModelWarmup(
  env: NodeJS.ProcessEnv,
  config: PersistedConfig,
  output: Pick<NodeJS.WritableStream, "write">,
  prepareLocalModel: PrepareLocalModel
): Promise<void> {
  let lastPercent = -1;
  const writeProgress = (percent: number) => {
    if (percent === lastPercent) {
      return;
    }

    lastPercent = percent;
    output.write(`(${percent}%) Downloading and loading Condense local model...\n`);
  };

  writeProgress(0);
  await prepareLocalModel({
    question: "Warm up Condense local model.",
    ...resolveRuntimeDefaults(env, config)
  }, writeProgress);
  output.write("Local Condense model ready\n");
}

async function prepareLocalModelIfNeeded(
  env: NodeJS.ProcessEnv,
  config: PersistedConfig,
  output: Pick<NodeJS.WritableStream, "write">,
  prepareLocalModel: PrepareLocalModel
): Promise<void> {
  if (config.provider !== "local" || !shouldPreloadLocalModel(env)) {
    return;
  }

  await runLocalModelWarmup(env, config, output, prepareLocalModel);
}

export async function warmupLocalModel({
  env,
  persisted = {},
  output = defaultOutput,
  prepareLocalModel
}: {
  env: NodeJS.ProcessEnv;
  persisted?: PersistedConfig;
  output?: Pick<NodeJS.WritableStream, "write">;
  prepareLocalModel?: PrepareLocalModel;
}): Promise<void> {
  const provider = persisted.provider ?? DEFAULT_PROVIDER;

  if (provider !== "local") {
    output.write("condense warmup skipped: provider is not local.\n");
    return;
  }

  const prepare =
    prepareLocalModel ??
    ((config, onProgress) => defaultPrepareLocalModel(env, config, onProgress));

  await runLocalModelWarmup(
    env,
    { ...persisted, provider: "local" },
    output,
    prepare
  );
}

function requirePromptValue<T>(value: T | symbol): T {
  if (typeof value === "symbol") {
    throw new Error("Onboarding cancelled.");
  }

  return value;
}

async function upsertInstructions(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });

  let current = "";

  try {
    current = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const blockPattern =
    /(?:\n{0,2})?<!-- condense skill: begin -->[\s\S]*?<!-- condense skill: end -->(?:\n{0,2})?/;

  if (blockPattern.test(current)) {
    const next = current.replace(blockPattern, `\n\n${AGENT_INSTRUCTIONS}\n\n`).trim();
    await writeFile(filePath, `${next}\n`);
    return;
  }

  const prefix = current.trim().length > 0 ? `${current.trimEnd()}\n\n` : "";
  await writeFile(filePath, `${prefix}${AGENT_INSTRUCTIONS}\n`);
}

async function directoryExists(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function resolveSkillSource(env: NodeJS.ProcessEnv): Promise<string> {
  const packageRoot = resolvePackageRoot(env);
  const candidates = [
    path.join(packageRoot, "skills", "condense"),
    path.join(import.meta.dir, "..", "skills", "condense"),
    path.join(import.meta.dir, "skills", "condense"),
    path.join(path.dirname(process.execPath), "skills", "condense"),
    path.join(resolveConfigBaseDir(env), "skills", "condense")
  ];

  for (const candidate of candidates) {
    if (await directoryExists(candidate)) {
      return candidate;
    }
  }

  const fallback = path.join(resolveConfigBaseDir(env), "skills", "condense");
  await mkdir(fallback, { recursive: true, mode: 0o700 });
  await writeFile(path.join(fallback, "SKILL.md"), embeddedCondenseSkill, {
    mode: 0o600
  });
  return fallback;
}

async function installSkill(env: NodeJS.ProcessEnv): Promise<void> {
  const home = resolveHome(env);
  const skillSource = await resolveSkillSource(env);
  const codexTarget = path.join(home, ".codex", "skills", "condense");
  const claudeTarget = path.join(home, ".claude", "skills", "condense");

  await mkdir(path.dirname(codexTarget), { recursive: true });
  await mkdir(path.dirname(claudeTarget), { recursive: true });
  await rm(codexTarget, { recursive: true, force: true });
  await rm(claudeTarget, { recursive: true, force: true });
  await cp(skillSource, codexTarget, { recursive: true });
  await cp(skillSource, claudeTarget, { recursive: true });
  await upsertInstructions(path.join(home, ".codex", "AGENTS.md"));
  await upsertInstructions(path.join(home, ".claude", "CLAUDE.md"));
}

async function runTuiOnboarding(
  env: NodeJS.ProcessEnv,
  persisted: PersistedConfig,
  prepareLocalModel: PrepareLocalModel
): Promise<void> {
  const prompts = await import("@clack/prompts");
  const currentHost = persisted.host ?? DEFAULT_HOST;
  const currentModel = persisted.model ?? DEFAULT_MODEL;
  const currentTimeout = persisted.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const currentProvider = safeProvider(persisted.provider);
  const currentLocalBackend = safeLocalBackend(persisted.localBackend);
  const currentLocalConcurrency =
    persisted.localConcurrency ?? DEFAULT_LOCAL_CONCURRENCY;
  const currentLocalHost = persisted.localHost ?? DEFAULT_LOCAL_HOST;
  const currentLocalPort = persisted.localPort ?? DEFAULT_LOCAL_PORT;

  prompts.intro("condense onboarding");

  try {
    const provider = requirePromptValue(
      await prompts.select<Provider>({
        message: "Choose model provider",
        initialValue: currentProvider,
        options: [
          {
            value: "local",
            label: "Condense local model",
            hint: "default; runs on this machine"
          },
          {
            value: "external",
            label: "External API",
            hint: "OpenAI-compatible endpoint"
          }
        ]
      })
    );
    const config: PersistedConfig = {
      ...persisted,
      provider
    };

    if (provider === "local") {
      config.localBackend = requirePromptValue(
        await prompts.select<LocalBackend>({
          message: "Local backend",
          initialValue: currentLocalBackend,
          options: [
            { value: "auto", label: "Auto", hint: "llama.cpp + v2 Q4 GGUF on all platforms" },
            { value: "llamacpp", label: "llama.cpp", hint: "resident llama-server" },
            { value: "mlx", label: "MLX (opt-in)", hint: "legacy distill2; not the default" }
          ]
        })
      );
      config.localConcurrency = parsePositiveInteger(
        requirePromptValue(
          await prompts.text({
            message: "Max concurrent local requests",
            defaultValue: String(currentLocalConcurrency),
            placeholder: String(DEFAULT_LOCAL_CONCURRENCY),
            validate: (value) => {
              try {
                parsePositiveInteger(value, currentLocalConcurrency, "local-concurrency");
              } catch (error) {
                return (error as Error).message;
              }

              return undefined;
            }
          })
        ),
        currentLocalConcurrency,
        "local-concurrency"
      );
      config.localHost = parseLocalHost(
        requirePromptValue(
          await prompts.text({
            message: "Local server host",
            defaultValue: currentLocalHost,
            placeholder: DEFAULT_LOCAL_HOST
          })
        ),
        currentLocalHost
      );
      config.localPort = parsePort(
        requirePromptValue(
          await prompts.text({
            message: "Local server port",
            defaultValue: String(currentLocalPort),
            placeholder: String(DEFAULT_LOCAL_PORT),
            validate: (value) => {
              try {
                parsePort(value, currentLocalPort);
              } catch (error) {
                return (error as Error).message;
              }

              return undefined;
            }
          })
        ),
        currentLocalPort
      );
      delete config.host;
      delete config.model;
      delete config.apiKey;
    } else {
      config.host =
        requirePromptValue(
          await prompts.text({
            message: "External API host",
            defaultValue: currentHost,
            placeholder: DEFAULT_HOST
          })
        ).trim() || currentHost;
      config.model =
        requirePromptValue(
          await prompts.text({
            message: "External model",
            defaultValue: currentModel,
            placeholder: DEFAULT_MODEL
          })
        ).trim() || currentModel;
      const apiKey = requirePromptValue(
        await prompts.text({
          message: "API key",
          placeholder: "optional"
        })
      );

      if (apiKey.trim()) {
        config.apiKey = apiKey.trim();
      }
    }

    config.timeoutMs = parseTimeout(
      requirePromptValue(
        await prompts.text({
          message: "Request timeout in ms",
          defaultValue: String(currentTimeout),
          placeholder: String(DEFAULT_TIMEOUT_MS),
          validate: (value) => {
            try {
              parseTimeout(value, currentTimeout);
            } catch (error) {
              return (error as Error).message;
            }

            return undefined;
          }
        })
      ),
      currentTimeout
    );

    const shouldInstall = requirePromptValue(
      await prompts.confirm({
        message: "Install /condense skill for Codex and Claude?",
        initialValue: true
      })
    );

    await writePersistedConfig(env, config);
    await seedGlobalDslMemory(env);
    prompts.log.success("Config saved");

    if (config.provider === "local" && shouldPreloadLocalModel(env)) {
      const spinner = prompts.spinner({ indicator: "dots" });
      const formatProgress = (percent: number) =>
        `(${percent}%) Downloading and loading Condense local model...`;
      spinner.start(formatProgress(0));

      try {
        await prepareLocalModel({
          question: "Warm up Condense local model.",
          ...resolveRuntimeDefaults(env, config)
        }, (percent) => spinner.message(formatProgress(percent)));
        spinner.stop("Local Condense model ready");
      } catch (error) {
        spinner.stop("Local Condense model failed to start", 1);
        throw error;
      }
    }

    if (shouldInstall) {
      const spinner = prompts.spinner({ indicator: "dots" });
      spinner.start("Installing /condense skill");
      await installSkill(env);
      spinner.stop("/condense skill installed for Codex and Claude");
      prompts.log.success("AGENTS.md and CLAUDE.md updated");
    } else {
      prompts.log.info("Skill install skipped");
    }

    prompts.outro("condense ready");
  } catch (error) {
    prompts.cancel((error as Error).message);
    throw error;
  }
}

export async function runOnboarding({
  env,
  input = defaultInput,
  output = defaultOutput,
  persisted = {},
  prepareLocalModel
}: OnboardingOptions): Promise<void> {
  const localPrepareModel: PrepareLocalModel =
    prepareLocalModel ??
    ((config, onProgress) => defaultPrepareLocalModel(env, config, onProgress));

  if (shouldUseTui(input, output, env)) {
    await runTuiOnboarding(env, persisted, localPrepareModel);
    return;
  }

  const rl = createInterface({ input, crlfDelay: Infinity });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (query: string): Promise<string> => {
    output.write(query);
    const next = await lines.next();

    return next.done ? "" : String(next.value);
  };
  const currentHost = persisted.host ?? DEFAULT_HOST;
  const currentModel = persisted.model ?? DEFAULT_MODEL;
  const currentTimeout = persisted.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const currentProvider = safeProvider(persisted.provider);
  const currentLocalBackend = safeLocalBackend(persisted.localBackend);
  const currentLocalConcurrency =
    persisted.localConcurrency ?? DEFAULT_LOCAL_CONCURRENCY;
  const currentLocalHost = persisted.localHost ?? DEFAULT_LOCAL_HOST;
  const currentLocalPort = persisted.localPort ?? DEFAULT_LOCAL_PORT;

  try {
    output.write("condense onboarding\n");
    const provider = parseProviderChoice(
      await ask(`provider local/external [${currentProvider}]: `)
    );
    const config: PersistedConfig = {
      ...persisted,
      provider
    };

    if (provider === "local") {
      config.localBackend = parseLocalBackend(
        await ask(`local-backend auto/llamacpp/mlx [${currentLocalBackend}]: `),
        currentLocalBackend
      );
      config.localConcurrency = parsePositiveInteger(
        await ask(`local-concurrency [${currentLocalConcurrency}]: `),
        currentLocalConcurrency,
        "local-concurrency"
      );
      config.localHost = parseLocalHost(
        await ask(`local-host [${currentLocalHost}]: `),
        currentLocalHost
      );
      config.localPort = parsePort(
        await ask(`local-port [${currentLocalPort}]: `),
        currentLocalPort
      );
      delete config.host;
      delete config.model;
      delete config.apiKey;
    } else {
      const host =
        (await ask(`host [${currentHost}]: `)).trim() || currentHost;
      const model =
        (await ask(`model [${currentModel}]: `)).trim() || currentModel;
      const apiKey = await ask("api-key optional []: ");

      config.host = host;
      config.model = model;

      if (apiKey.trim()) {
        config.apiKey = apiKey.trim();
      }
    }

    config.timeoutMs = parseTimeout(
      await ask(`timeout-ms optional [${currentTimeout}]: `),
      currentTimeout
    );

    const shouldInstall = parseInstallChoice(
      await ask("install /condense skill for Codex and Claude? [Y/n]: ")
    );

    await writePersistedConfig(env, config);
    await seedGlobalDslMemory(env);
    output.write("config saved\n");
    await prepareLocalModelIfNeeded(env, config, output, localPrepareModel);

    if (shouldInstall) {
      await installSkill(env);
      output.write("/condense skill installed for Codex and Claude\n");
      output.write("AGENTS.md and CLAUDE.md updated\n");
    } else {
      output.write("skill install skipped\n");
    }
  } finally {
    rl.close();
  }
}

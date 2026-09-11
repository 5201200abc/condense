import cliPackage from "../packages/cli/package.json";

export const CONDENSE_VERSION = cliPackage.version;

export const DEFAULT_MODEL = "qwen3.5:2b";
export const DEFAULT_HOST = "http://127.0.0.1:11434/v1";
export const DEFAULT_TIMEOUT_MS = 90_000;
export const DEFAULT_PROVIDER = "local";
export const DEFAULT_LOCAL_BACKEND = "auto";
export const DEFAULT_LOCAL_CONCURRENCY = 5;
export const DEFAULT_LOCAL_HOST = "127.0.0.1";
export const DEFAULT_LOCAL_PORT = 8009;
export const CONDENSE_MLX_MODEL = "samuelfaj/distill2-0.6B-4bit-MLX";
export const CONDENSE_LLAMA_MODEL = "condense-local";
export const CONDENSE_LLAMA_GGUF_FILENAME = "condense-0.8B-Q4_K_M.gguf";
export const DEFAULT_IDLE_MS = 1_200;
export const DEFAULT_INTERACTIVE_GAP_MS = 180;
export const DEFAULT_PROGRESS_FRAME_MS = 120;
export const DEFAULT_DATASET_ENABLED = false;
export const DEFAULT_AUTO_LEARN = true;
export const DEFAULT_AUTO_LEARN_SCOPE = "project";
export const DEFAULT_AUTO_LEARN_SOURCE = "output";
export const DEFAULT_AUTO_PROMOTE_SCOPES = true;
export const DEFAULT_MAX_PROMPT_DSL_ENTRIES = 40;

export type Provider = "local" | "external";
export type LocalBackend = "auto" | "mlx" | "llamacpp";

export interface CondenseSettings {
  provider: Provider;
  localBackend: LocalBackend;
  localConcurrency: number;
  localHost: string;
  localPort: number;
  model: string;
  host: string;
  apiKey: string;
  timeoutMs: number;
  datasetEnabled: boolean;
  datasetPath?: string;
  autoLearn?: boolean;
  autoLearnScope?: "project";
  autoLearnSource?: "output";
  autoPromoteScopes?: boolean;
  maxPromptDslEntries?: number;
  showStats?: boolean;
}

export interface RuntimeConfig extends CondenseSettings {
  question: string;
}

export type PersistedConfig = Partial<CondenseSettings>;

export type ConfigKey =
  | "provider"
  | "local-backend"
  | "local-concurrency"
  | "local-host"
  | "local-port"
  | "model"
  | "host"
  | "api-key"
  | "timeout-ms"
  | "dataset-enabled"
  | "dataset-path"
  | "auto-learn"
  | "auto-promote-scopes"
  | "max-prompt-dsl-entries";

export type Command =
  | { kind: "onboard" }
  | { kind: "warmup" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "upgrade" }
  | { kind: "dsl"; args: string[] }
  | { kind: "stats"; args: string[] }
  | { kind: "recall"; args: string[] }
  | { kind: "configShow" }
  | { kind: "configGet"; key: ConfigKey }
  | { kind: "configSet"; key: ConfigKey; value: string | number | boolean }
  | {
      kind: "translate";
      text: string;
      language: string;
      config: RuntimeConfig;
    }
  | { kind: "run"; config: RuntimeConfig };

export class UsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function readFlagValue(
  argv: string[],
  index: number,
  name: string
): { value: string; nextIndex: number } {
  const current = argv[index];
  const inline = current.slice(name.length + 1);

  if (inline.length > 0) {
    return { value: inline, nextIndex: index };
  }

  const next = argv[index + 1];

  if (!next) {
    throw new UsageError(`Missing value for ${name}.`);
  }

  return { value: next, nextIndex: index + 1 };
}

function coerceTimeout(input: string | undefined): number {
  const value = Number(input ?? DEFAULT_TIMEOUT_MS);

  if (!Number.isFinite(value) || value <= 0) {
    throw new UsageError("Timeout must be a positive number.");
  }

  return Math.floor(value);
}

function normalizeHost(input: string | undefined): string {
  const value = (input ?? DEFAULT_HOST).trim();

  if (!value) {
    throw new UsageError("Host cannot be empty.");
  }

  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function normalizeLocalHost(input: string | undefined): string {
  const value = (input ?? DEFAULT_LOCAL_HOST).trim();

  if (!value) {
    throw new UsageError("local-host cannot be empty.");
  }

  return value;
}

export function coerceBoolean(input: string | boolean | undefined): boolean {
  if (typeof input === "boolean") {
    return input;
  }

  const value = String(input ?? DEFAULT_DATASET_ENABLED).trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }

  throw new UsageError("Boolean values must be true or false.");
}

function coercePositiveInteger(input: string | number | undefined, label: string): number {
  const value = Number(input);

  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`${label} must be a positive integer.`);
  }

  return value;
}

function coercePort(input: string | number | undefined, label: string): number {
  const value = coercePositiveInteger(input, label);

  if (value > 65_535) {
    throw new UsageError(`${label} must be between 1 and 65535.`);
  }

  return value;
}

function coerceProvider(input: string | undefined): Provider {
  const value = (input ?? DEFAULT_PROVIDER).trim().toLowerCase();

  if (value === "local" || value === "external") {
    return value;
  }

  throw new UsageError("provider must be local or external.");
}

function coercePersistedProvider(input: string | undefined): Provider {
  try {
    return coerceProvider(input);
  } catch {
    return DEFAULT_PROVIDER;
  }
}

function coerceLocalBackend(input: string | undefined): LocalBackend {
  const value = (input ?? DEFAULT_LOCAL_BACKEND).trim().toLowerCase();

  if (value === "auto" || value === "mlx" || value === "llamacpp") {
    return value;
  }

  throw new UsageError("local-backend must be auto, mlx, or llamacpp.");
}

function coercePersistedLocalBackend(input: string | undefined): LocalBackend {
  try {
    return coerceLocalBackend(input);
  } catch {
    return DEFAULT_LOCAL_BACKEND;
  }
}

function localBackendForPlatform(
  backend: LocalBackend
): Exclude<LocalBackend, "auto"> {
  if (backend !== "auto") {
    return backend;
  }

  return "llamacpp";
}

function resolveLocalModel(backend: LocalBackend): string {
  return localBackendForPlatform(backend) === "mlx"
    ? CONDENSE_MLX_MODEL
    : CONDENSE_LLAMA_MODEL;
}

export function bracketIpv6Host(host: string): string {
  if (host.includes(":") && !host.startsWith("[")) {
    return `[${host}]`;
  }

  return host;
}

function resolveLocalHost(localHost: string, localPort: number): string {
  return `http://${bracketIpv6Host(localHost)}:${localPort}/v1`;
}

export function resolveRuntimeDefaults(
  env: NodeJS.ProcessEnv,
  persisted: PersistedConfig
): CondenseSettings {
  const hasExternalEnv = Boolean(
    env.CONDENSE_HOST || env.CONDENSE_MODEL || env.CONDENSE_API_KEY
  );
  const provider = env.CONDENSE_PROVIDER
    ? coerceProvider(env.CONDENSE_PROVIDER)
    : hasExternalEnv
      ? "external"
    : persisted.provider
      ? coercePersistedProvider(persisted.provider)
      : DEFAULT_PROVIDER;
  const localBackend = env.CONDENSE_LOCAL_BACKEND
    ? coerceLocalBackend(env.CONDENSE_LOCAL_BACKEND)
    : coercePersistedLocalBackend(persisted.localBackend);
  const localConcurrency = coercePositiveInteger(
    env.CONDENSE_LOCAL_CONCURRENCY ??
      persisted.localConcurrency ??
      DEFAULT_LOCAL_CONCURRENCY,
    "local-concurrency"
  );
  const localHost = normalizeLocalHost(
    env.CONDENSE_LOCAL_HOST ?? persisted.localHost ?? DEFAULT_LOCAL_HOST
  );
  const localPort = coercePort(
    env.CONDENSE_LOCAL_PORT ?? persisted.localPort ?? DEFAULT_LOCAL_PORT,
    "local-port"
  );
  const model =
    provider === "local"
      ? resolveLocalModel(localBackend)
      : env.CONDENSE_MODEL ?? persisted.model ?? DEFAULT_MODEL;
  const host =
    provider === "local"
      ? resolveLocalHost(localHost, localPort)
      : normalizeHost(env.CONDENSE_HOST ?? persisted.host ?? DEFAULT_HOST);
  const apiKey = provider === "local" ? "" : env.CONDENSE_API_KEY ?? persisted.apiKey ?? "";
  const timeoutMs = coerceTimeout(
    env.CONDENSE_TIMEOUT_MS ?? String(persisted.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  );
  const datasetEnabled = coerceBoolean(
    env.CONDENSE_DATASET_ENABLED ?? persisted.datasetEnabled
  );
  const datasetPath = env.CONDENSE_DATASET_PATH ?? persisted.datasetPath;
  const autoLearn = coerceBoolean(
    env.CONDENSE_AUTO_LEARN ?? persisted.autoLearn ?? DEFAULT_AUTO_LEARN
  );
  const autoPromoteScopes = coerceBoolean(
    env.CONDENSE_AUTO_PROMOTE_SCOPES ??
      persisted.autoPromoteScopes ??
      DEFAULT_AUTO_PROMOTE_SCOPES
  );
  const maxPromptDslEntries = coercePositiveInteger(
    env.CONDENSE_MAX_PROMPT_DSL_ENTRIES ??
      persisted.maxPromptDslEntries ??
      DEFAULT_MAX_PROMPT_DSL_ENTRIES,
    "max-prompt-dsl-entries"
  );
  const showStats = coerceBoolean(
    env.CONDENSE_SHOW_STATS ?? persisted.showStats ?? false
  );

  return {
    provider,
    localBackend,
    localConcurrency,
    localHost,
    localPort,
    model,
    host,
    apiKey,
    timeoutMs,
    datasetEnabled,
    datasetPath,
    autoLearn,
    autoLearnScope: DEFAULT_AUTO_LEARN_SCOPE,
    autoLearnSource: DEFAULT_AUTO_LEARN_SOURCE,
    autoPromoteScopes,
    maxPromptDslEntries,
    showStats
  };
}

function parseConfigCommand(argv: string[]): Command {
  if (argv.length === 1) {
    return { kind: "configShow" };
  }

  const key = argv[1] as ConfigKey;

  if (
    ![
      "model",
      "host",
      "provider",
      "local-backend",
      "local-concurrency",
      "local-host",
      "local-port",
      "api-key",
      "timeout-ms",
      "dataset-enabled",
      "dataset-path",
      "auto-learn",
      "auto-promote-scopes",
      "max-prompt-dsl-entries"
    ].includes(key)
  ) {
    throw new UsageError(`Unknown config key: ${argv[1]}`);
  }

  if (argv.length === 2) {
    return { kind: "configGet", key };
  }

  const rawValue = argv.slice(2).join(" ").trim();

  if (!rawValue) {
    throw new UsageError(`Missing value for config key ${key}.`);
  }

  if (key === "timeout-ms") {
    return {
      kind: "configSet",
      key,
      value: coerceTimeout(rawValue)
    };
  }

  if (key === "provider") {
    return {
      kind: "configSet",
      key,
      value: coerceProvider(rawValue)
    };
  }

  if (key === "local-backend") {
    return {
      kind: "configSet",
      key,
      value: coerceLocalBackend(rawValue)
    };
  }

  if (key === "local-concurrency") {
    return {
      kind: "configSet",
      key,
      value: coercePositiveInteger(rawValue, key)
    };
  }

  if (key === "local-host") {
    return {
      kind: "configSet",
      key,
      value: normalizeLocalHost(rawValue)
    };
  }

  if (key === "local-port") {
    return {
      kind: "configSet",
      key,
      value: coercePort(rawValue, key)
    };
  }

  if (key === "host") {
    return {
      kind: "configSet",
      key,
      value: normalizeHost(rawValue)
    };
  }

  if (key === "dataset-enabled") {
    return {
      kind: "configSet",
      key,
      value: coerceBoolean(rawValue)
    };
  }

  if (key === "auto-learn" || key === "auto-promote-scopes") {
    return {
      kind: "configSet",
      key,
      value: coerceBoolean(rawValue)
    };
  }

  if (key === "max-prompt-dsl-entries") {
    return {
      kind: "configSet",
      key,
      value: coercePositiveInteger(rawValue, key)
    };
  }

  return {
    kind: "configSet",
    key,
    value: rawValue
  };
}

export function parseCommand(
  argv: string[],
  env: NodeJS.ProcessEnv,
  persisted: PersistedConfig = {},
  options: { stdinIsTTY?: boolean } = {}
): Command {
  if (argv[0] === "onboard") {
    return { kind: "onboard" };
  }

  if (argv[0] === "warmup") {
    return { kind: "warmup" };
  }

  if (argv.length === 0) {
    if (options.stdinIsTTY === false) {
      throw new UsageError("A question is required.");
    }

    return { kind: "onboard" };
  }

  if (argv[0] === "config") {
    return parseConfigCommand(argv);
  }

  if (argv[0] === "dsl") {
    return { kind: "dsl", args: argv.slice(1) };
  }

  if (argv[0] === "stats" || argv[0] === "savings") {
    return { kind: "stats", args: argv.slice(1) };
  }

  if (argv[0] === "recall") {
    return { kind: "recall", args: argv.slice(1) };
  }

  if (argv[0] === "upgrade" || argv[0] === "update") {
    return { kind: "upgrade" };
  }

  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return { kind: "help" };
  }

  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    return { kind: "version" };
  }

  const defaults = resolveRuntimeDefaults(env, persisted);

  if (argv[0] === "translate") {
    if (!argv[1]?.trim()) {
      throw new UsageError("/condense text is required.");
    }

    if (argv.length > 3) {
      throw new UsageError("Usage: condense translate <text> [language]");
    }

    return {
      kind: "translate",
      text: argv[1],
      language: argv[2] ?? "en-US",
      config: {
        question: "Translate /condense output into human language.",
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
        maxPromptDslEntries: defaults.maxPromptDslEntries,
        showStats: defaults.showStats
      }
    };
  }

  let timeoutMs = defaults.timeoutMs;
  let modelOverride: string | undefined;
  let hostOverride: string | undefined;
  let apiKeyOverride: string | undefined;
  let showStats = defaults.showStats;
  const questionParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      questionParts.push(...argv.slice(index + 1));
      break;
    }

    if (token === "--stats") {
      showStats = true;
      continue;
    }

    if (token === "--model" || token.startsWith("--model=")) {
      const parsed = readFlagValue(argv, index, "--model");
      modelOverride = parsed.value;
      index = parsed.nextIndex;
      continue;
    }

    if (token === "--host" || token.startsWith("--host=")) {
      const parsed = readFlagValue(argv, index, "--host");
      hostOverride = parsed.value;
      index = parsed.nextIndex;
      continue;
    }

    if (token === "--api-key" || token.startsWith("--api-key=")) {
      const parsed = readFlagValue(argv, index, "--api-key");
      apiKeyOverride = parsed.value;
      index = parsed.nextIndex;
      continue;
    }

    if (token === "--timeout-ms" || token.startsWith("--timeout-ms=")) {
      const parsed = readFlagValue(argv, index, "--timeout-ms");
      timeoutMs = coerceTimeout(parsed.value);
      index = parsed.nextIndex;
      continue;
    }

    if (token.startsWith("-")) {
      throw new UsageError(`Unknown flag: ${token}`);
    }

    questionParts.push(token);
  }

  const question = questionParts.join(" ").trim();

  if (!question) {
    throw new UsageError("A question is required.");
  }

  const provider =
    modelOverride || hostOverride || apiKeyOverride ? "external" : defaults.provider;
  const model =
    provider === "external"
      ? modelOverride ?? env.CONDENSE_MODEL ?? persisted.model ?? DEFAULT_MODEL
      : defaults.model;
  const host =
    provider === "external"
      ? normalizeHost(hostOverride ?? env.CONDENSE_HOST ?? persisted.host ?? DEFAULT_HOST)
      : defaults.host;
  const apiKey =
    provider === "external"
      ? apiKeyOverride ?? env.CONDENSE_API_KEY ?? persisted.apiKey ?? ""
      : "";

  return {
    kind: "run",
    config: {
      question,
      provider,
      localBackend: defaults.localBackend,
      localConcurrency: defaults.localConcurrency,
      localHost: defaults.localHost,
      localPort: defaults.localPort,
      model,
      host,
      apiKey,
      timeoutMs,
      datasetEnabled: defaults.datasetEnabled,
      datasetPath: defaults.datasetPath,
      autoLearn: defaults.autoLearn,
      autoLearnScope: defaults.autoLearnScope,
      autoLearnSource: defaults.autoLearnSource,
      autoPromoteScopes: defaults.autoPromoteScopes,
      maxPromptDslEntries: defaults.maxPromptDslEntries,
      showStats
    }
  };
}

export function formatUsage(): string {
  return [
    "Usage:",
    '  cmd 2>&1 | condense "question"',
    '  cmd 2>&1 | condense --stats "question"',
    "  condense stats",
    "  condense stats -H",
    "  condense stats --project",
    "  condense stats --json",
    "  condense stats --days 7",
    "  condense stats --reset",
    "  condense recall <id>",
    "  condense recall <id> --grep <pattern>",
    "  condense recall <id> --around <pattern> -C 20",
    "  condense onboard",
    "  condense warmup",
    "  condense update",
    "  condense dsl show",
    "  condense dsl show --candidates",
    '  condense dsl learn --dry-run "Dict+: A1=auth fix"',
    "  condense dsl promote --dry-run",
    '  condense dsl add alias A1 "auth fix" --scope project',
    '  condense translate "Best: Fix auth bug. Pass: tests pass." [language]',
    '  condense config host http://127.0.0.1:11434/v1',
    '  condense config model "qwen3.5:2b"',
    "  condense config provider external",
    "  condense config provider local",
    '  condense --host http://127.0.0.1:1234/v1 --model my-model "summarize"',
    "",
    "Options:",
    "  --stats               Print character savings summary to stderr on completion",
    `  --model <name>        External model name (default local model: ${CONDENSE_LLAMA_MODEL})`,
    `  --host <url>          External OpenAI-compatible base URL (default local: http://${DEFAULT_LOCAL_HOST}:${DEFAULT_LOCAL_PORT}/v1)`,
    "  --api-key <key>       API key (env: CONDENSE_API_KEY)",
    `  --timeout-ms <ms>     Request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})`,
    "",
    "Local model defaults:",
    `  CONDENSE_PROVIDER=external        Use an external OpenAI-compatible API`,
    `  CONDENSE_LOCAL_BACKEND=llamacpp   Local backend (default auto -> llamacpp; mlx is opt-in)`,
    `  CONDENSE_LLAMA_GGUF=<path>        Override v2 Q4 GGUF (default ${CONDENSE_LLAMA_GGUF_FILENAME})`,
    `  CONDENSE_LOCAL_CONCURRENCY=5      Max concurrent local model requests`,
    `  CONDENSE_LOCAL_PORT=${DEFAULT_LOCAL_PORT}       Local model server port`,
    "",
    "Local fine-tuning capture (disabled by default):",
    "  When enabled, successful batch summaries are appended as JSONL under",
    "  the config dir (input + completion). The file is created with mode 0600.",
    "  CONDENSE_DATASET_ENABLED=true   Enable local JSONL dataset capture",
    "  CONDENSE_DATASET_PATH=<path>    Override dataset JSONL path",
    "  CONDENSE_AUTO_LEARN=false       Disable project-scoped DSL auto-learn",
    "  CONDENSE_MAX_PROMPT_DSL_ENTRIES=<n>  Limit DSL entries injected into prompts",
    "  --help                Show usage",
    "  --version             Show version"
  ].join("\n");
}

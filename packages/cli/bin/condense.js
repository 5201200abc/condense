#!/usr/bin/env node

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const requireFromHere = createRequire(__filename);

const PACKAGE_BY_TARGET = {
  "darwin-arm64": {
    packageName: "condense-darwin-arm64",
    binaryName: "condense"
  },
  "darwin-x64": {
    packageName: "condense-darwin-x64",
    binaryName: "condense"
  },
  "linux-arm64": {
    packageName: "condense-linux-arm64",
    binaryName: "condense"
  },
  "linux-x64": {
    packageName: "condense-linux-x64",
    binaryName: "condense"
  },
  "win32-x64": {
    packageName: "condense-win32-x64",
    binaryName: "condense.exe"
  }
};

function resolveBinaryPath() {
  const target = `${process.platform}-${process.arch}`;
  const targetSpec = PACKAGE_BY_TARGET[target];

  if (!targetSpec) {
    console.error(
      `[condense] Unsupported platform: ${process.platform}/${process.arch}.`
    );
    process.exit(1);
  }

  const workspaceBinaryPath = path.resolve(
    __dirname,
    "..",
    "..",
    `condense-${target}`,
    "bin",
    targetSpec.binaryName
  );

  if (fs.existsSync(workspaceBinaryPath)) {
    return workspaceBinaryPath;
  }

  try {
    const packageJsonPath = requireFromHere.resolve(`${targetSpec.packageName}/package.json`);
    return path.join(path.dirname(packageJsonPath), "bin", targetSpec.binaryName);
  } catch (error) {
    console.error(
      `[condense] Missing platform package ${targetSpec.packageName}. Reinstall condense for this platform.`
    );
    process.exit(1);
  }
}

const PROGRESS_PREFIX = "__CONDENSE_PROGRESS__:";
const PROGRESS_FRAMES = ["-", "\\", "|", "/"];
const PROGRESS_DOT_FRAMES = ["", ".", "..", "...", "..", "."];
const PROGRESS_LABELS = {
  collecting: "condense: waiting",
  summarizing: "condense: summarizing"
};

function isSummarizeInvocation(argv) {
  if (argv.length === 0) {
    return false;
  }

  const head = argv[0];
  return ![
    "onboard",
    "warmup",
    "config",
    "dsl",
    "stats",
    "savings",
    "upgrade",
    "update",
    "translate",
    "--help",
    "-h",
    "--version",
    "-v"
  ].includes(head);
}

const binPath = resolveBinaryPath();
const progressWriter = process.stderr.isTTY ? process.stderr : process.stdout.isTTY ? process.stdout : null;
let progressPhase = "collecting";
let progressFrame = 0;
let progressTimer = null;
let progressVisible = false;
let childStderrBuffer = "";

function renderProgress() {
  if (!progressWriter) {
    return;
  }

  const frame = PROGRESS_FRAMES[progressFrame % PROGRESS_FRAMES.length];
  const dots =
    PROGRESS_DOT_FRAMES[
      Math.floor(progressFrame / PROGRESS_FRAMES.length) % PROGRESS_DOT_FRAMES.length
    ];
  progressFrame += 1;
  progressWriter.write(
    `\r\u001b[2K${frame} ${PROGRESS_LABELS[progressPhase] || PROGRESS_LABELS.collecting}${dots}`
  );
  progressVisible = true;
}

function startProgress() {
  if (!progressWriter || progressTimer) {
    return;
  }

  renderProgress();
  progressTimer = setInterval(renderProgress, 120);
}

function stopProgress() {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }

  if (progressVisible && progressWriter) {
    progressWriter.write("\r\u001b[2K");
    progressVisible = false;
  }
}

function handleChildStderrLine(line) {
  if (!line) {
    return;
  }

  if (!line.startsWith(PROGRESS_PREFIX)) {
    stopProgress();
    process.stderr.write(`${line}\n`);
    return;
  }

  if (line === `${PROGRESS_PREFIX}stop`) {
    stopProgress();
    return;
  }

  if (line.startsWith(`${PROGRESS_PREFIX}phase:`)) {
    progressPhase = line.slice(`${PROGRESS_PREFIX}phase:`.length) || "collecting";
    progressFrame = 0;
    renderProgress();
  }
}

function flushChildStderr(force = false) {
  if (!force && !childStderrBuffer.includes("\n")) {
    return;
  }

  const parts = childStderrBuffer.split("\n");
  childStderrBuffer = force ? "" : parts.pop() || "";

  for (const line of parts) {
    handleChildStderrLine(line);
  }

  if (force && childStderrBuffer) {
    handleChildStderrLine(childStderrBuffer);
    childStderrBuffer = "";
  }
}

const childArgv = process.argv.slice(2);
const child = spawn(binPath, childArgv, {
  stdio: ["inherit", "pipe", "pipe"],
  env: {
    ...process.env,
    CONDENSE_PACKAGE_ROOT: path.resolve(__dirname, ".."),
    CONDENSE_PROGRESS_PROTOCOL: "stderr",
    CONDENSE_STDIN_TTY: process.stdin.isTTY ? "1" : "0",
    CONDENSE_STDOUT_TTY: process.stdout.isTTY ? "1" : "0",
    CONDENSE_STDERR_TTY: process.stderr.isTTY ? "1" : "0"
  }
});

if (isSummarizeInvocation(childArgv)) {
  startProgress();
}

child.stdout.on("data", (chunk) => {
  stopProgress();
  process.stdout.write(chunk);
});

child.stderr.on("data", (chunk) => {
  childStderrBuffer += chunk.toString("utf8");
  flushChildStderr();
});

const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

["SIGINT", "SIGTERM", "SIGHUP"].forEach((signal) => {
  process.on(signal, () => forwardSignal(signal));
});

child.on("error", (error) => {
  stopProgress();
  console.error(`[condense] Failed to launch native binary: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  flushChildStderr(true);
  stopProgress();

  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

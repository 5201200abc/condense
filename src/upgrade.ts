import { copyFile, mkdir } from "node:fs/promises";
import { chmodSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { CONDENSE_VERSION } from "./config";
import { getCurrentPlatformKey, getPlatformTarget } from "../scripts/platform-targets";

export const NPM_PACKAGE_NAME = "condense";
export const EXPECTED_NPM_REPO = "5201200abc/condense";
const NPM_LATEST_URL = `https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`;

export interface NpmLatestMeta {
  version?: string;
  repository?: string | { url?: string };
}

export interface UpgradeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  copyFile?: typeof copyFile;
}

export function publishedVersionIfThisProject(meta: NpmLatestMeta): string | null {
  const repo =
    typeof meta.repository === "string" ? meta.repository : meta.repository?.url ?? "";
  if (!repo.includes(EXPECTED_NPM_REPO)) {
    return null;
  }
  const version = meta.version?.trim() ?? "";
  return version.length > 0 ? version : null;
}

export async function fetchPublishedNpmVersion(
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetchImpl(NPM_LATEST_URL, {
      headers: { "User-Agent": `condense/${CONDENSE_VERSION}` },
      signal: controller.signal
    });

    if (!res.ok) {
      return null;
    }

    return publishedVersionIfThisProject((await res.json()) as NpmLatestMeta);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function resolveRepoRoot(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const starts = [env.CONDENSE_PACKAGE_ROOT, cwd].filter(
    (value): value is string => Boolean(value)
  );

  for (const start of starts) {
    let dir = path.resolve(start);
    for (let i = 0; i < 8; i += 1) {
      if (
        existsSync(path.join(dir, "src/cli.ts")) &&
        existsSync(path.join(dir, "packages/cli/package.json"))
      ) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }

  return null;
}

export function resolvePlatformBinary(
  repoRoot: string,
  platform = process.platform,
  arch = process.arch
): string | null {
  const target = getPlatformTarget(getCurrentPlatformKey(platform, arch));
  if (!target) {
    return null;
  }
  const binaryPath = path.join(repoRoot, target.packageBinaryPath);
  return existsSync(binaryPath) ? binaryPath : null;
}

export function resolveInstallPath(env: NodeJS.ProcessEnv = process.env): string {
  const target = getPlatformTarget(getCurrentPlatformKey());
  const binaryName = target?.binaryName ?? "condense";
  const installDir = env.CONDENSE_INSTALL_DIR?.trim();
  if (installDir) {
    return path.join(installDir, binaryName);
  }
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home) {
    throw new Error("Could not resolve HOME for condense update.");
  }
  return path.join(home, ".local", "bin", binaryName);
}

function readBinaryVersion(binaryPath: string): string {
  const result = spawnSync(binaryPath, ["--version"], {
    encoding: "utf8",
    timeout: 5000
  });
  return (result.stdout || "").trim();
}

export async function installRepoBinary(
  options: UpgradeOptions = {}
): Promise<{ dest: string; version: string } | null> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = resolveRepoRoot(cwd, env);
  if (!repoRoot) {
    return null;
  }
  const source = resolvePlatformBinary(repoRoot);
  if (!source) {
    return null;
  }
  const dest = resolveInstallPath(env);
  if (path.resolve(source) === path.resolve(dest)) {
    return { dest, version: readBinaryVersion(dest) || CONDENSE_VERSION };
  }
  await mkdir(path.dirname(dest), { recursive: true });
  await (options.copyFile ?? copyFile)(source, dest);
  chmodSync(dest, 0o755);
  return { dest, version: readBinaryVersion(dest) || CONDENSE_VERSION };
}

export async function runUpgradeCommand(
  fetchImpl: typeof fetch = fetch,
  options: UpgradeOptions = {}
): Promise<string> {
  const currentVersion = CONDENSE_VERSION;
  const latestVersion = await fetchPublishedNpmVersion(fetchImpl);
  const lines = [`Current version: v${currentVersion}`];

  if (latestVersion && latestVersion !== currentVersion) {
    lines.push(`Latest version : v${latestVersion}`);
    lines.push("");
    lines.push("To upgrade condense, run:");
    lines.push(`  npm install -g ${NPM_PACKAGE_NAME}@latest`);
    return `${lines.join("\n")}\n`;
  }

  if (latestVersion && latestVersion === currentVersion) {
    lines.push("condense is up to date.");
    return `${lines.join("\n")}\n`;
  }

  const installed = await installRepoBinary(options);
  if (installed) {
    lines.push(`Installed ${installed.dest}`);
    lines.push(`Updated to v${installed.version}`);
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    `Public npm package "${NPM_PACKAGE_NAME}" is not this project yet.`,
    "When CI publishes it, upgrade with:",
    `  npm install -g ${NPM_PACKAGE_NAME}@latest`
  );
  return `${lines.join("\n")}\n`;
}

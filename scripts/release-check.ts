import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  getCurrentPlatformKey,
  getPlatformTarget,
  PLATFORM_TARGETS
} from "./platform-targets";

const root = path.resolve(import.meta.dir, "..");
const requireAllBinaries = Bun.argv.includes("--publish");
const currentPlatformKey = getCurrentPlatformKey();
const workspacePackages = [
  "packages/cli/package.json",
  ...PLATFORM_TARGETS.map((target) => target.packageManifestPath)
];

const binaries = requireAllBinaries
  ? PLATFORM_TARGETS.map((target) => target.packageBinaryPath)
  : [getPlatformTarget(currentPlatformKey)?.packageBinaryPath].filter(Boolean);

const manifests = await Promise.all(
  workspacePackages.map(async (relativePath) => {
    const content = await readFile(path.join(root, relativePath), "utf8");
    return JSON.parse(content) as { name: string; version: string };
  })
);

const versions = new Set(manifests.map((manifest) => manifest.version));

if (versions.size !== 1) {
  throw new Error("Workspace package versions are out of sync.");
}

for (const binary of binaries) {
  await access(path.join(root, binary));
}

if (binaries.length === 0) {
  throw new Error(`Unsupported platform for release check: ${currentPlatformKey}`);
}

const cliManifest = manifests[0];

if (cliManifest.name !== "condense") {
  throw new Error("Main package name must be condense.");
}

for (const manifest of manifests.slice(1) as Array<Record<string, unknown>>) {
  if (!Array.isArray(manifest.os) || !Array.isArray(manifest.cpu)) {
    throw new Error(
      `Platform package ${String(manifest.name)} must include os/cpu metadata.`
    );
  }
}

import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { getCurrentPlatformKey, selectPlatformTargets } from "./platform-targets";

const root = path.resolve(import.meta.dir, "..");
const currentTargetKey = getCurrentPlatformKey();
const selectedTargets = selectPlatformTargets({
  buildAll: process.env.CONDENSE_BUILD_ALL === "1" || process.env.DISTILL_BUILD_ALL === "1"
});

if (selectedTargets.length === 0) {
  throw new Error(`Unsupported sync target for this machine: ${currentTargetKey}.`);
}

for (const target of selectedTargets) {
  const source = path.join(root, target.buildOutputPath);
  const destination = path.join(root, target.packageBinaryPath);

  await stat(source);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);

  if (!destination.endsWith(".exe")) {
    await chmod(destination, 0o755);
  }
}

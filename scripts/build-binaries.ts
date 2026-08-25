import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { getCurrentPlatformKey, selectPlatformTargets } from "./platform-targets";

const root = path.resolve(import.meta.dir, "..");
const entrypoint = path.join(root, "src", "cli.ts");
const currentTargetKey = getCurrentPlatformKey();
const selectedTargets = selectPlatformTargets({
  buildAll: process.env.CONDENSE_BUILD_ALL === "1"
});

if (selectedTargets.length === 0) {
  throw new Error(`Unsupported build target for this machine: ${currentTargetKey}.`);
}

for (const target of selectedTargets) {
  const outfile = path.join(root, target.buildOutputPath);
  await mkdir(path.dirname(outfile), { recursive: true });

  const result = spawnSync(
    "bun",
    [
      "build",
      "--compile",
      `--target=${target.bunTarget}`,
      `--outfile=${outfile}`,
      entrypoint
    ],
    {
      cwd: root,
      stdio: "inherit"
    }
  );

  if (result.status !== 0) {
    throw new Error(`Failed to compile ${target.bunTarget}.`);
  }
}

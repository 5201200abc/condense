export interface PlatformTarget {
  key: string;
  packageName: string;
  packageManifestPath: string;
  binaryName: string;
  packageBinaryPath: string;
  bunTarget: string;
  buildOutputPath: string;
  os: readonly string[];
  cpu: readonly string[];
}

export const PLATFORM_TARGETS: PlatformTarget[] = [
  {
    key: "darwin-arm64",
    packageName: "condense-darwin-arm64",
    packageManifestPath: "packages/condense-darwin-arm64/package.json",
    binaryName: "condense",
    packageBinaryPath: "packages/condense-darwin-arm64/bin/condense",
    bunTarget: "bun-darwin-arm64",
    buildOutputPath: ".dist/bun-darwin-arm64/condense",
    os: ["darwin"],
    cpu: ["arm64"]
  },
  {
    key: "darwin-x64",
    packageName: "condense-darwin-x64",
    packageManifestPath: "packages/condense-darwin-x64/package.json",
    binaryName: "condense",
    packageBinaryPath: "packages/condense-darwin-x64/bin/condense",
    bunTarget: "bun-darwin-x64",
    buildOutputPath: ".dist/bun-darwin-x64/condense",
    os: ["darwin"],
    cpu: ["x64"]
  },
  {
    key: "linux-arm64",
    packageName: "condense-linux-arm64",
    packageManifestPath: "packages/condense-linux-arm64/package.json",
    binaryName: "condense",
    packageBinaryPath: "packages/condense-linux-arm64/bin/condense",
    bunTarget: "bun-linux-arm64",
    buildOutputPath: ".dist/bun-linux-arm64/condense",
    os: ["linux"],
    cpu: ["arm64"]
  },
  {
    key: "linux-x64",
    packageName: "condense-linux-x64",
    packageManifestPath: "packages/condense-linux-x64/package.json",
    binaryName: "condense",
    packageBinaryPath: "packages/condense-linux-x64/bin/condense",
    bunTarget: "bun-linux-x64",
    buildOutputPath: ".dist/bun-linux-x64/condense",
    os: ["linux"],
    cpu: ["x64"]
  },
  {
    key: "win32-x64",
    packageName: "condense-win32-x64",
    packageManifestPath: "packages/condense-win32-x64/package.json",
    binaryName: "condense.exe",
    packageBinaryPath: "packages/condense-win32-x64/bin/condense.exe",
    bunTarget: "bun-windows-x64",
    buildOutputPath: ".dist/bun-windows-x64/condense.exe",
    os: ["win32"],
    cpu: ["x64"]
  }
];

export function getCurrentPlatformKey(
  platform = process.platform,
  arch = process.arch
): string {
  return `${platform}-${arch}`;
}

export function getPlatformTarget(key: string): PlatformTarget | undefined {
  return PLATFORM_TARGETS.find((target) => target.key === key);
}

export function selectPlatformTargets(options?: {
  buildAll?: boolean;
  platform?: string;
  arch?: string;
}): PlatformTarget[] {
  if (options?.buildAll) {
    return PLATFORM_TARGETS;
  }

  const key = getCurrentPlatformKey(options?.platform, options?.arch);
  const target = getPlatformTarget(key);
  return target ? [target] : [];
}

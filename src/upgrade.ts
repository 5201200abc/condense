import { CONDENSE_VERSION } from "./config";

export const NPM_PACKAGE_NAME = "condense";
export const EXPECTED_NPM_REPO = "5201200abc/condense";
const NPM_LATEST_URL = `https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`;

export interface NpmLatestMeta {
  version?: string;
  repository?: string | { url?: string };
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

export async function runUpgradeCommand(
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const currentVersion = CONDENSE_VERSION;
  const latestVersion = await fetchPublishedNpmVersion(fetchImpl);
  const lines = [`Current version: v${currentVersion}`];

  if (!latestVersion) {
    lines.push(
      `Public npm package "${NPM_PACKAGE_NAME}" is not this project yet.`,
      "When CI publishes it, upgrade with:",
      `  npm install -g ${NPM_PACKAGE_NAME}@latest`
    );
    return `${lines.join("\n")}\n`;
  }

  if (latestVersion !== currentVersion) {
    lines.push(`Latest version : v${latestVersion}`);
    lines.push("");
    lines.push("To upgrade condense, run:");
    lines.push(`  npm install -g ${NPM_PACKAGE_NAME}@latest`);
    return `${lines.join("\n")}\n`;
  }

  lines.push("condense is up to date.");
  return `${lines.join("\n")}\n`;
}

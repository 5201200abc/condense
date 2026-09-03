import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLockPid(lockPath: string): Promise<number | null> {
  try {
    const raw = (await readFile(lockPath, "utf8")).trim();
    const pid = Number(raw);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

export async function withFileLock<T>(
  lockPath: string,
  callback: () => Promise<T>,
  options: { timeoutMs?: number; pollMs?: number } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 50;
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      const holder = await readLockPid(lockPath);

      if (holder === null || !pidIsAlive(holder)) {
        await rm(lockPath, { force: true });
        continue;
      }

      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for lock: ${lockPath}`);
      }

      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  try {
    return await callback();
  } finally {
    await rm(lockPath, { force: true });
  }
}

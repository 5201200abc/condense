export function envTtyFlag(
  env: NodeJS.ProcessEnv,
  name: string
): boolean | undefined {
  const value = env[name]?.trim().toLowerCase();

  if (value === "1" || value === "true" || value === "yes") {
    return true;
  }

  if (value === "0" || value === "false" || value === "no") {
    return false;
  }

  return undefined;
}

export function stdinIsTTY(
  env: NodeJS.ProcessEnv = process.env,
  stream: { isTTY?: boolean } = process.stdin
): boolean {
  return envTtyFlag(env, "CONDENSE_STDIN_TTY") ?? Boolean(stream.isTTY);
}

export function stdoutIsTTY(
  env: NodeJS.ProcessEnv = process.env,
  stream: { isTTY?: boolean } = process.stdout
): boolean {
  return envTtyFlag(env, "CONDENSE_STDOUT_TTY") ?? Boolean(stream.isTTY);
}

export function stderrIsTTY(
  env: NodeJS.ProcessEnv = process.env,
  stream: { isTTY?: boolean } = process.stderr
): boolean {
  return envTtyFlag(env, "CONDENSE_STDERR_TTY") ?? Boolean(stream.isTTY);
}

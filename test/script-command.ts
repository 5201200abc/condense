interface ScriptCommand {
  command: string;
  args: string[];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function createScriptCommand(
  capturePath: string,
  command: string,
  args: string[]
): ScriptCommand {
  if (process.platform === "linux") {
    const shellCommand = [command, ...args].map(shellQuote).join(" ");

    return {
      command: "script",
      args: ["-q", "-e", "-c", shellCommand, capturePath]
    };
  }

  return {
    command: "script",
    args: ["-q", capturePath, command, ...args]
  };
}

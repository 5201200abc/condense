import { describe, expect, it } from "bun:test";

import { stdinIsTTY, stdoutIsTTY } from "../src/tty";

describe("tty helpers", () => {
  it("honors CONDENSE_STDOUT_TTY over the stream flag", () => {
    expect(stdoutIsTTY({ CONDENSE_STDOUT_TTY: "1" }, { isTTY: false })).toBe(true);
    expect(stdoutIsTTY({ CONDENSE_STDOUT_TTY: "0" }, { isTTY: true })).toBe(false);
    expect(stdoutIsTTY({}, { isTTY: true })).toBe(true);
  });

  it("honors CONDENSE_STDIN_TTY over the stream flag", () => {
    expect(stdinIsTTY({ CONDENSE_STDIN_TTY: "1" }, { isTTY: false })).toBe(true);
    expect(stdinIsTTY({ CONDENSE_STDIN_TTY: "false" }, { isTTY: true })).toBe(false);
  });
});

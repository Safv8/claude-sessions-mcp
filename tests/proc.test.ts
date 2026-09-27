import { describe, expect, it } from "vitest";
import { parseBridgeArgv, parseWindowsProbe, splitWindowsCommandLine } from "../src/proc.js";

const bridge = (extra: string[] = []) => [
  "/usr/local/bin/claude", "remote-control", ...extra,
];

describe("parseBridgeArgv", () => {
  it("reads name, capacity and spawn mode", () => {
    expect(parseBridgeArgv(bridge(["--name", "demo", "--spawn", "worktree", "--capacity", "4"])))
      .toEqual({ name: "demo", capacity: 4, spawnMode: "worktree" });
  });

  it("defaults capacity to the CLI default when absent", () => {
    expect(parseBridgeArgv(bridge(["--name", "demo"])))
      .toEqual({ name: "demo", capacity: 32, spawnMode: null });
  });

  it("returns a null name when --name is absent, leaving the fallback to the caller", () => {
    expect(parseBridgeArgv(bridge())).toEqual({ name: null, capacity: 32, spawnMode: null });
  });

  it("ignores a capacity that is not a positive integer", () => {
    expect(parseBridgeArgv(bridge(["--capacity", "nonsense"]))?.capacity).toBe(32);
  });

  it("is not fooled by a process that merely mentions the words", () => {
    expect(parseBridgeArgv(["/bin/bash", "-c", "echo claude remote-control"])).toBeNull();
    expect(parseBridgeArgv(["/usr/local/bin/claude", "--help"])).toBeNull();
  });
});

describe("parseBridgeArgv on Windows", () => {
  it("recognises the native claude.exe, quoted or not, in any case", () => {
    for (const exe of [String.raw`C:\Users\me\.local\bin\claude.exe`, String.raw`C:\Tools\Claude.EXE`, "claude"]) {
      expect(parseBridgeArgv([exe, "remote-control", "--name", "vault"])?.name).toBe("vault");
    }
  });

  it("is not fooled by a similarly named executable", () => {
    expect(parseBridgeArgv([String.raw`C:\bin\notclaude.exe`, "remote-control"])).toBeNull();
  });
});

describe("splitWindowsCommandLine", () => {
  it("splits on whitespace and keeps quoted spaces together", () => {
    expect(splitWindowsCommandLine(String.raw`"C:\Program Files\x.exe"  a "b c"` + "\td"))
      .toEqual([String.raw`C:\Program Files\x.exe`, "a", "b c", "d"]);
  });

  it("keeps backslashes literal unless they precede a quote", () => {
    expect(splitWindowsCommandLine(String.raw`C:\a\b \\server\share`))
      .toEqual([String.raw`C:\a\b`, String.raw`\\server\share`]);
    // \" is a quote; \\" is one backslash then a closing quote; \\\" is a backslash and a quote.
    expect(splitWindowsCommandLine(String.raw`a\"b "c\\" d\\\"e`))
      .toEqual(['a"b', "c\\", String.raw`d\"e`]);
  });

  it("keeps an empty quoted argument", () => {
    expect(splitWindowsCommandLine('x "" y')).toEqual(["x", "", "y"]);
  });
});

describe("parseWindowsProbe", () => {
  // The shape powershell.exe printed for a live bridge and its first worker.
  const probe = JSON.stringify([
    { pid: 34420, ppid: 27612, cwd: String.raw`C:\projects\marketplace-management`, started: 1790523837000,
      cmd: String.raw`C:\Users\safve\.local\bin\claude.exe remote-control --name mm-test --spawn worktree --capacity 2` },
    { pid: 33668, ppid: 34420, cwd: String.raw`C:\projects\marketplace-management`,
      cmd: String.raw`C:\Users\safve\.local\bin\claude.exe --print --sdk-url https://api.anthropic.com/v1/code/sessions/cse_01 --session-id cse_01` },
    { pid: 4, ppid: 0, cwd: null, cmd: null },
  ]);

  it("turns each row into argv, cwd and start time, dropping rows without a command line", () => {
    const [bridge, worker, ...rest] = parseWindowsProbe(probe);
    expect(bridge).toEqual({
      pid: 34420, ppid: 27612, cwd: String.raw`C:\projects\marketplace-management`, startedAt: 1790523837000,
      argv: [String.raw`C:\Users\safve\.local\bin\claude.exe`, "remote-control", "--name", "mm-test", "--spawn", "worktree", "--capacity", "2"],
    });
    expect(worker.argv).toContain("--sdk-url");
    expect(worker.startedAt).toBeNull();
    expect(rest).toEqual([]);
    expect(parseBridgeArgv(bridge.argv)).toEqual({ name: "mm-test", capacity: 2, spawnMode: "worktree" });
  });

  it("accepts an empty probe", () => {
    expect(parseWindowsProbe("\r\n")).toEqual([]);
    expect(parseWindowsProbe("[]")).toEqual([]);
  });
});

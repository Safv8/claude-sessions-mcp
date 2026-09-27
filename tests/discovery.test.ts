import { describe, expect, it } from "vitest";
import { discoverInstances } from "../src/discovery.js";
import type { ProcessInfo } from "../src/proc.js";

const bridge = (pid: number, name: string | null, cwd: string, extra: string[] = []): ProcessInfo => ({
  pid, ppid: 1, cwd,
  argv: ["/usr/local/bin/claude", "remote-control", ...(name ? ["--name", name] : []), ...extra],
});

const worker = (pid: number, ppid: number): ProcessInfo => ({
  pid, ppid, cwd: "/srv/project",
  argv: ["/opt/claude", "--print", "--sdk-url", "https://api.example.test/v1/code/sessions/s-1"],
});

const deps = (processes: ProcessInfo[], pointers: { environmentId: string; pid: number }[]) => ({
  proc: { list: async () => processes },
  readPointers: async () => pointers,
});

describe("discoverInstances", () => {
  it("joins a bridge process to its pointer and counts its workers", async () => {
    const found = await discoverInstances(deps(
      [bridge(100, "alpha", "/srv/alpha", ["--capacity", "4", "--spawn", "same-dir"]), worker(101, 100), worker(102, 100)],
      [{ environmentId: "env-alpha", pid: 100 }],
    ));
    expect(found).toEqual([{
      name: "alpha", cwd: "/srv/alpha", pid: 100, environmentId: "env-alpha",
      capacity: 4, workers: 2, spawnMode: "same-dir",
    }]);
  });

  it("drops a pointer whose process is gone", async () => {
    const found = await discoverInstances(deps([], [{ environmentId: "env-dead", pid: 999 }]));
    expect(found).toEqual([]);
  });

  it("drops a bridge that has no pointer, since it cannot be addressed", async () => {
    const found = await discoverInstances(deps([bridge(100, "alpha", "/srv/alpha")], []));
    expect(found).toEqual([]);
  });

  it("falls back to the directory name when --name is absent", async () => {
    const [found] = await discoverInstances(deps(
      [bridge(100, null, "/srv/my-project")],
      [{ environmentId: "env-1", pid: 100 }],
    ));
    expect(found.name).toBe("my-project");
  });

  it("does not count another bridge's workers", async () => {
    const found = await discoverInstances(deps(
      [bridge(100, "alpha", "/srv/alpha"), bridge(200, "beta", "/srv/beta"), worker(101, 100)],
      [{ environmentId: "env-alpha", pid: 100 }, { environmentId: "env-beta", pid: 200 }],
    ));
    expect(found.map((i) => [i.name, i.workers])).toEqual([["alpha", 1], ["beta", 0]]);
  });

  it("reads a Windows bridge: backslash cwd, claude.exe, directory-name fallback", async () => {
    const exe = String.raw`C:\Users\me\.local\bin\claude.exe`;
    const found = await discoverInstances(deps(
      [
        { pid: 10, ppid: 1, cwd: String.raw`C:\projects\pelamigo.com`, argv: [exe, "remote-control", "--spawn", "worktree", "--capacity", "6"] },
        { pid: 11, ppid: 10, cwd: String.raw`C:\projects\pelamigo.com`, argv: [exe, "--print", "--sdk-url", "https://api.example.test/v1/code/sessions/cse_1"] },
      ],
      [{ environmentId: "env-p", pid: 10 }],
    ));
    expect(found).toEqual([{
      name: "pelamigo.com", cwd: String.raw`C:\projects\pelamigo.com`, pid: 10, environmentId: "env-p",
      capacity: 6, workers: 1, spawnMode: "worktree",
    }]);
  });
});

describe("discoverInstances for a bridge without a pointer (--no-create-session-in-dir)", () => {
  const started = Date.parse("2026-09-27T16:00:00Z");
  const vault = { pid: 20, ppid: 1, cwd: String.raw`C:\vault`, startedAt: started,
    argv: [String.raw`C:\Users\me\.local\bin\claude.exe`, "remote-control", "--name", "vault", "--no-create-session-in-dir"] };
  const env = (id: string, at: string, over: Partial<{ machine: string; directory: string; online: boolean }> = {}) => ({
    environmentId: id, machine: "Desktop-AMD", directory: String.raw`C:\vault`, online: true, createdAt: Date.parse(at), ...over,
  });
  const find = (environments: ReturnType<typeof env>[], proc: ProcessInfo = vault) => discoverInstances({
    proc: { list: async () => [proc] },
    readPointers: async () => [],
    readEnvironments: async () => environments,
    hostname: "desktop-amd",
  });

  it("takes the newest online environment of this machine and directory", async () => {
    const [found] = await find([
      env("env-killed", "2026-09-27T15:40:00Z"), // an earlier bridge, killed, still listed online
      env("env-live", "2026-09-27T16:00:04Z", { directory: "c:\\VAULT" }),
      env("env-elsewhere", "2026-09-27T16:00:05Z", { machine: "laptop" }),
      env("env-other-dir", "2026-09-27T16:00:06Z", { directory: String.raw`C:\projects\feedsync` }),
      env("env-offline", "2026-09-27T16:00:07Z", { online: false }),
    ]);
    expect(found.environmentId).toBe("env-live");
  });

  it("refuses an environment older than the bridge: that one belongs to a dead predecessor", async () => {
    expect(await find([env("env-killed", "2026-09-27T15:40:00Z")])).toEqual([]);
  });

  it("does not guess when the process start time is unknown", async () => {
    expect(await find([env("env-live", "2026-09-27T16:00:04Z")], { ...vault, startedAt: null })).toEqual([]);
  });

  it("does not ask the API when every bridge has a pointer", async () => {
    let asked = false;
    await discoverInstances({
      proc: { list: async () => [vault] },
      readPointers: async () => [{ environmentId: "env-pointer", pid: 20 }],
      readEnvironments: async () => { asked = true; return []; },
    });
    expect(asked).toBe(false);
  });
});

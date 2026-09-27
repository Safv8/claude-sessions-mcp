import { readFile, readdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join, win32 } from "node:path";
import type { BridgeEnvironment } from "./api.js";
import { defaultProcSource, parseBridgeArgv, type ProcessInfo, type ProcSource } from "./proc.js";
import type { BridgeInstance } from "./types.js";

export interface BridgePointer {
  environmentId: string;
  pid: number;
}

export interface DiscoveryDeps {
  proc: ProcSource;
  readPointers(): Promise<BridgePointer[]>;
  /**
   * The account's bridge environments. Only consulted for a bridge that wrote
   * no pointer, which is what `--no-create-session-in-dir` does: the pointer
   * names the pre-created session, so without one there is no pointer at all.
   */
  readEnvironments?(): Promise<BridgeEnvironment[]>;
  hostname?: string;
}

/**
 * How far the API's clock may run behind ours. A bridge registers its
 * environment seconds after it starts, so an environment much older than the
 * process belongs to an earlier bridge in the same directory — one that was
 * killed and is still listed as online.
 */
const CLOCK_SKEW_MS = 120_000;

/**
 * The bridges running on this machine, each joined to the environment it
 * registered: through its pointer file when it wrote one, otherwise through
 * the environment list. A bridge whose environment cannot be established is
 * left out: without an environment id there is nothing we could ask it to do.
 */
export async function discoverInstances(deps: DiscoveryDeps): Promise<BridgeInstance[]> {
  const [processes, pointers] = await Promise.all([deps.proc.list(), deps.readPointers()]);
  const byPid = new Map(pointers.map((p) => [p.pid, p.environmentId]));

  const workersByParent = new Map<number, number>();
  for (const p of processes) {
    if (p.argv.includes("--sdk-url")) {
      workersByParent.set(p.ppid, (workersByParent.get(p.ppid) ?? 0) + 1);
    }
  }

  const bridges = processes.flatMap((p) => {
    const argv = parseBridgeArgv(p.argv);
    return argv && p.cwd ? [{ p, argv, cwd: p.cwd }] : [];
  });
  const unpointed = bridges.filter((b) => !byPid.has(b.p.pid));
  const environments = unpointed.length > 0 && deps.readEnvironments ? await deps.readEnvironments() : [];
  const host = deps.hostname ?? hostname();

  const instances: BridgeInstance[] = [];
  for (const { p, argv, cwd } of bridges) {
    const environmentId = byPid.get(p.pid) ?? environmentOf(p, cwd, environments, host);
    if (!environmentId) continue;
    instances.push({
      name: argv.name ?? win32.basename(cwd), // splits on / and \ alike
      cwd,
      pid: p.pid,
      environmentId,
      capacity: argv.capacity,
      workers: workersByParent.get(p.pid) ?? 0,
      spawnMode: argv.spawnMode,
    });
  }
  return instances;
}

/**
 * The newest online environment registered from this machine for the
 * bridge's directory, provided it is not older than the bridge itself.
 * Anything less certain is no answer.
 */
function environmentOf(p: ProcessInfo, cwd: string, environments: BridgeEnvironment[], host: string): string | null {
  if (!p.startedAt) return null;
  const newest = environments
    .filter((e) => e.online && e.machine.toLowerCase() === host.toLowerCase() && samePath(e.directory, cwd))
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  return newest && newest.createdAt >= p.startedAt - CLOCK_SKEW_MS ? newest.environmentId : null;
}

/** Windows paths compare case-insensitively; everything else exactly. */
function samePath(a: string, b: string): boolean {
  return /^[a-z]:[\\/]/i.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Reads every `<projectsDir>/<slug>/bridge-pointer.json` Claude Code has written. */
export async function readPointersFrom(projectsDir: string): Promise<BridgePointer[]> {
  const slugs = await readdir(projectsDir).catch(() => [] as string[]);
  const pointers = await Promise.all(slugs.map(async (slug) => {
    const raw = await readFile(join(projectsDir, slug, "bridge-pointer.json"), "utf8").catch(() => null);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as { environmentId?: unknown; pid?: unknown };
      if (typeof parsed.environmentId !== "string" || typeof parsed.pid !== "number") return null;
      return { environmentId: parsed.environmentId, pid: parsed.pid };
    } catch {
      return null; // a half-written pointer is not an error worth failing discovery over
    }
  }));
  return pointers.filter((p): p is BridgePointer => p !== null);
}

export function defaultDiscoveryDeps(
  claudeConfigDir: string,
  api?: { listBridgeEnvironments(): Promise<BridgeEnvironment[]> },
): DiscoveryDeps {
  return {
    proc: defaultProcSource,
    readPointers: () => readPointersFrom(join(claudeConfigDir, "projects")),
    readEnvironments: api && (() => api.listBridgeEnvironments()),
  };
}

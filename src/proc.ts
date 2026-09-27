import { execFile } from "node:child_process";
import { readFile, readdir, readlink } from "node:fs/promises";
import { promisify } from "node:util";

export interface ProcessInfo {
  pid: number;
  ppid: number;
  argv: string[];
  cwd: string | null;
  /** When the process started, ms since the epoch; null when the platform cannot tell. */
  startedAt?: number | null;
}

export interface ProcSource {
  list(): Promise<ProcessInfo[]>;
}

export interface BridgeArgv {
  name: string | null;
  capacity: number;
  spawnMode: string | null;
}

/** The CLI's own default when --capacity is not given. */
export const DEFAULT_CAPACITY = 32;

function flagValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/**
 * Recognises a Remote Control bridge by its argv and reads what it declares.
 * Returns null for anything else, including shells whose command line merely
 * contains the words.
 */
export function parseBridgeArgv(argv: string[]): BridgeArgv | null {
  const [exe, subcommand] = argv;
  if (!exe || !/(^|[\\/])claude(\.exe)?$/i.test(exe)) return null;
  if (subcommand !== "remote-control") return null;

  const rawCapacity = flagValue(argv, "--capacity");
  const capacity = Number(rawCapacity);
  return {
    name: flagValue(argv, "--name"),
    capacity: Number.isInteger(capacity) && capacity > 0 ? capacity : DEFAULT_CAPACITY,
    spawnMode: flagValue(argv, "--spawn"),
  };
}

/** Linux implementation: everything comes from /proc. */
export const linuxProcSource: ProcSource = {
  async list(): Promise<ProcessInfo[]> {
    const entries = await readdir("/proc");
    const pids = entries.filter((e) => /^\d+$/.test(e)).map(Number);
    const btime = Number(/^btime (\d+)$/m.exec(await readFile("/proc/stat", "utf8"))?.[1]);
    const infos = await Promise.all(pids.map((pid) => readProcess(pid, btime)));
    return infos.filter((p): p is ProcessInfo => p !== null);
  },
};

/** USER_HZ, the unit of /proc/<pid>/stat's starttime; fixed at 100 by the kernel ABI. */
const USER_HZ = 100;

async function readProcess(pid: number, btime: number): Promise<ProcessInfo | null> {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
    const argv = raw.split("\0").filter((s) => s.length > 0);
    if (argv.length === 0) return null;
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // fields[0] is field 3, state
    const ppid = Number(fields[1]);
    const startedAt = (btime + Number(fields[19]) / USER_HZ) * 1000;
    const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => null);
    return {
      pid, ppid: Number.isFinite(ppid) ? ppid : 0, argv, cwd,
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
    };
  } catch {
    return null; // the process exited while we were reading it
  }
}

/**
 * Splits a Windows command line into argv the way CommandLineToArgvW does:
 * quotes group, a backslash escapes only a quote or a run of backslashes
 * before one, and `""` inside quotes is a literal quote.
 */
export function splitWindowsCommandLine(line: string): string[] {
  const argv: string[] = [];
  let arg = "", inQuotes = false, started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") {
      let n = 0;
      while (line[i] === "\\") { n++; i++; }
      if (line[i] === '"') {
        arg += "\\".repeat(n >> 1);
        if (n % 2) arg += '"'; else i--;
      } else {
        arg += "\\".repeat(n);
        i--;
      }
      started = true;
    } else if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { arg += '"'; i++; } else inQuotes = !inQuotes;
      started = true;
    } else if ((c === " " || c === "\t") && !inQuotes) {
      if (started) argv.push(arg);
      arg = ""; started = false;
    } else {
      arg += c; started = true;
    }
  }
  if (started) argv.push(arg);
  return argv;
}

/**
 * Windows has no /proc and no tool that reports another process's working
 * directory, so one PowerShell call lists the candidate processes (a bridge or
 * a worker, by command line) and reads each one's current directory from its
 * PEB. Assumes 64-bit processes, which the native Claude Code build is.
 */
const WINDOWS_PROBE = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ProcCwd {
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr[] pbi, int len, out int ret);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static byte[] Read(IntPtr h, long addr, int n) {
    var buf = new byte[n]; IntPtr got;
    if (!ReadProcessMemory(h, new IntPtr(addr), buf, new IntPtr(n), out got) || got.ToInt64() != n) return null;
    return buf;
  }
  // 64-bit layouts: PEB+0x20 -> RTL_USER_PROCESS_PARAMETERS, +0x38 -> CurrentDirectory.DosPath.
  public static string Get(int pid) {
    if (IntPtr.Size != 8) return null;
    IntPtr h = OpenProcess(0x1010, false, pid); // QUERY_LIMITED_INFORMATION | VM_READ
    if (h == IntPtr.Zero) return null;
    try {
      var pbi = new IntPtr[6]; int ret;
      if (NtQueryInformationProcess(h, 0, pbi, 48, out ret) != 0) return null;
      var pp = Read(h, pbi[1].ToInt64() + 0x20, 8); if (pp == null) return null;
      var us = Read(h, BitConverter.ToInt64(pp, 0) + 0x38, 16); if (us == null) return null;
      var s = Read(h, BitConverter.ToInt64(us, 8), BitConverter.ToUInt16(us, 0)); if (s == null) return null;
      var path = Encoding.Unicode.GetString(s);
      return path.Length > 3 ? path.TrimEnd('\\') : path;
    } finally { CloseHandle(h); }
  }
}
'@
$list = Get-CimInstance Win32_Process -Filter "CommandLine like '%remote-control%' or CommandLine like '%--sdk-url%'" |
  ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; cmd = $_.CommandLine; cwd = [ProcCwd]::Get([int]$_.ProcessId)
    started = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null } } }
ConvertTo-Json -Compress -InputObject @($list)
`;

const execFileAsync = promisify(execFile);

export const windowsProcSource: ProcSource = {
  async list(): Promise<ProcessInfo[]> {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", Buffer.from(WINDOWS_PROBE, "utf16le").toString("base64"),
    ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return parseWindowsProbe(stdout);
  },
};

/** The probe's JSON, one object per process, into ProcessInfo. */
export function parseWindowsProbe(stdout: string): ProcessInfo[] {
  const rows = JSON.parse(stdout.trim() || "[]") as
    { pid: number; ppid: number; cmd: string | null; cwd: string | null; started?: number | null }[];
  return rows
    .filter((r) => r.cmd)
    .map((r) => ({
      pid: r.pid, ppid: r.ppid, argv: splitWindowsCommandLine(r.cmd!), cwd: r.cwd ?? null, startedAt: r.started ?? null,
    }));
}

export const defaultProcSource: ProcSource = process.platform === "win32" ? windowsProcSource : linuxProcSource;

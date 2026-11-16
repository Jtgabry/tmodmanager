import { readdir, readFile } from 'node:fs/promises'

/** Tick di clock al secondo (getconf CLK_TCK): 100 su tutti i kernel Linux x86_64. */
const CLK_TCK = 100

export type ProcessInfo = {
  pid: number
  ppid: number
  args: string[]
  /** utime + stime, in tick */
  cpuTicks: number
  /** avvio del processo, in tick dal boot */
  startTicks: number
}

/** Interpreta /proc/<pid>/stat. Il campo comm può contenere spazi e parentesi: si parte dall'ultima ")". */
export function parseStat(stat: string) {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  // fields[0] = state (campo 3 del man proc), quindi campo N → fields[N - 3]
  return {
    ppid: Number(fields[1]),
    cpuTicks: Number(fields[11]) + Number(fields[12]),
    startTicks: Number(fields[19]),
  }
}

/** Fotografia di tutti i processi visibili. Quelli che terminano durante la lettura vengono saltati. */
export async function listProcesses(): Promise<ProcessInfo[]> {
  const pids = (await readdir('/proc')).filter((e) => /^\d+$/.test(e))
  const results = await Promise.all(
    pids.map(async (pid) => {
      try {
        const [stat, cmdline] = await Promise.all([
          readFile(`/proc/${pid}/stat`, 'utf8'),
          readFile(`/proc/${pid}/cmdline`, 'utf8'),
        ])
        return { pid: Number(pid), ...parseStat(stat), args: cmdline.split('\0').filter(Boolean) }
      } catch {
        return null
      }
    }),
  )
  return results.filter((p): p is ProcessInfo => p !== null)
}

export function isAncestor(procs: ProcessInfo[], ancestorPid: number, pid: number): boolean {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  for (let p = byPid.get(pid); p && p.pid > 1; p = byPid.get(p.ppid)) {
    if (p.ppid === ancestorPid) return true
  }
  return false
}

export async function memoryBytes(pid: number): Promise<number> {
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8')
    const kb = status.match(/^VmRSS:\s+(\d+) kB/m)
    return kb ? Number(kb[1]) * 1024 : 0
  } catch {
    return 0
  }
}

export async function systemUptimeTicks(): Promise<number> {
  const uptime = await readFile('/proc/uptime', 'utf8')
  return Number(uptime.split(' ')[0]) * CLK_TCK
}

export const ticksToSeconds = (ticks: number) => ticks / CLK_TCK

export type SocketCounts = { listening: boolean; established: number }

/** Conta i socket TCP su una porta locale leggendo /proc/net/tcp e tcp6 (st 0A = LISTEN, 01 = ESTABLISHED). */
export function parseTcpTable(table: string, port: number): SocketCounts {
  const portHex = port.toString(16).toUpperCase().padStart(4, '0')
  let listening = false
  let established = 0
  for (const line of table.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 4 || !cols[1].endsWith(`:${portHex}`)) continue
    if (cols[3] === '0A') listening = true
    if (cols[3] === '01') established++
  }
  return { listening, established }
}

export async function socketsOnPort(port: number): Promise<SocketCounts> {
  const tables = await Promise.all(
    ['/proc/net/tcp', '/proc/net/tcp6'].map((f) => readFile(f, 'utf8').catch(() => '')),
  )
  return tables
    .map((t) => parseTcpTable(t, port))
    .reduce((a, b) => ({ listening: a.listening || b.listening, established: a.established + b.established }))
}

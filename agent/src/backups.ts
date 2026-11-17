import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { config } from './config.js'
import type { ServerManager } from './manager.js'
import { paths } from './paths.js'
import { loadServers, type ServerDefinition } from './registry.js'
import { applyServerConfig, readServerConfig } from './serverConfig.js'
import { trashWorld } from './serverAdmin.js'
import { readZipComment, writeZip } from './zip.js'

/**
 * Backup dei mondi: uno .zip per backup in data/servers/<id>/backups/, con il .wld (e il .twld dei server
 * tModLoader). Nome: <Mondo>_backup_<YmdHis>.zip. Se il server è acceso prima si fa salvare il mondo.
 * Ogni giorno all'ora config.backupTime si fa un backup automatico di tutti i server che hanno un mondo.
 */

export class BackupError extends Error {
  constructor(
    message: string,
    public readonly status: 404 | 409 | 422 = 422,
  ) {
    super(message)
  }
}

export const BACKUP_NAME = /^([A-Za-z_-]{1,64})_backup_(\d{14})\.zip$/
const COMMENT_PREFIX = 'tmodmanager-backup:'
const SAVE_TIMEOUT_MS = 60_000

export type Backup = {
  name: string
  createdAt: string
  size: number
  world: string
  /** Fatto dal backup giornaliero (questi vengono ruotati). */
  auto: boolean
  files: string[]
}

/** Nome del mondo per il nome del file: solo lettere, - e _ (gli spazi diventano _). */
export function normalizeWorldName(name: string): string {
  const clean = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z_-]/g, '')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, 40)
  return clean || 'Mondo'
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Data e ora locali come YmdHis (20261117040000). */
export const timestamp = (d: Date) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

const parseTimestamp = (s: string) =>
  new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14))

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

/** File del mondo da salvare: il .wld e, per tModLoader, il .twld (se c'è). */
async function worldFiles(server: ServerDefinition): Promise<{ world: string; files: string[] }> {
  const { world } = await readServerConfig(server.configPath)
  if (!world || !(await exists(world))) {
    throw new BackupError('Il server non ha ancora un mondo: viene generato al primo avvio', 409)
  }
  const files = [world]
  const twld = world.replace(/\.wld$/i, '.twld')
  if (server.game === 'tmodloader' && (await exists(twld))) files.push(twld)
  return { world, files }
}

/**
 * Server acceso: comando "save" e attesa che tutti i file del mondo vengano riscritti e smettano di
 * cambiare. Se non succede in tempo si usa l'ultimo salvataggio su disco (lo dice il risultato).
 */
async function saveRunningWorld(server: ServerDefinition, files: string[], manager: ServerManager): Promise<boolean> {
  const status = await manager.status(server)
  if (status.state !== 'running' || !status.managed) return false
  const since = Date.now() - 1000
  await manager.sendCommand(server, 'save')
  const deadline = Date.now() + SAVE_TIMEOUT_MS
  let previous = ''
  while (Date.now() < deadline) {
    await sleep(500)
    const infos = await Promise.all(files.map((f) => stat(f).catch(() => null)))
    if (infos.every((i) => i && i.mtimeMs >= since)) {
      const current = infos.map((i) => `${i!.size}:${i!.mtimeMs}`).join('|')
      if (current === previous) return true
      previous = current
    }
  }
  return false
}

const running = new Set<string>()

export type BackupResult = { backup: Backup; saved: boolean; running: boolean }

/** Fa un backup del mondo del server. `auto`: backup giornaliero (ruotato). */
export async function createBackup(server: ServerDefinition, manager: ServerManager, auto = false): Promise<BackupResult> {
  if (running.has(server.id)) throw new BackupError('C\'è già un backup in corso per questo server', 409)
  running.add(server.id)
  try {
    const { world, files } = await worldFiles(server)
    const wasRunning = (await manager.status(server)).state !== 'stopped'
    const saved = wasRunning ? await saveRunningWorld(server, files, manager) : true

    const dir = paths.backups(server.id)
    await mkdir(dir, { recursive: true })
    let when = new Date()
    let name = `${normalizeWorldName(basename(world).replace(/\.wld$/i, ''))}_backup_${timestamp(when)}.zip`
    // Due backup nello stesso secondo: si va al secondo dopo
    while (await exists(join(dir, name))) {
      when = new Date(when.getTime() + 1000)
      name = name.replace(/_backup_\d{14}\.zip$/, `_backup_${timestamp(when)}.zip`)
    }
    const tmp = join(dir, `.${randomBytes(4).toString('hex')}.tmp`)
    try {
      await writeZip(
        tmp,
        files.map((path) => ({ name: basename(path), path })),
        `${COMMENT_PREFIX}${JSON.stringify({ auto, files: files.map((f) => basename(f)) })}`,
      )
      await rename(tmp, join(dir, name))
    } finally {
      await rm(tmp, { force: true })
    }
    if (auto) await pruneAutomatic(server)
    return { backup: await describe(server, name), saved, running: wasRunning }
  } finally {
    running.delete(server.id)
  }
}

async function describe(server: ServerDefinition, name: string): Promise<Backup> {
  const match = name.match(BACKUP_NAME)
  if (!match) throw new BackupError('Backup non trovato', 404)
  const path = join(paths.backups(server.id), name)
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw new BackupError('Backup non trovato', 404)
  let meta: { auto?: boolean; files?: string[] } = {}
  const comment = await readZipComment(path).catch(() => '')
  if (comment.startsWith(COMMENT_PREFIX)) {
    try {
      meta = JSON.parse(comment.slice(COMMENT_PREFIX.length)) as typeof meta
    } catch {
      // commento non nostro
    }
  }
  const world = match[1]
  return {
    name,
    createdAt: parseTimestamp(match[2]).toISOString(),
    size: info.size,
    world,
    auto: meta.auto === true,
    files: Array.isArray(meta.files) ? meta.files.filter((f) => typeof f === 'string') : [],
  }
}

/** Backup del server, dal più recente. */
export async function listBackups(server: ServerDefinition): Promise<Backup[]> {
  const names = (await readdir(paths.backups(server.id)).catch(() => [] as string[])).filter((n) => BACKUP_NAME.test(n))
  const list = await Promise.all(names.map((n) => describe(server, n).catch(() => null)))
  return list.filter((b): b is Backup => b !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name))
}

/** Percorso di un backup (404 se il nome non è valido o non esiste). */
export async function backupPath(server: ServerDefinition, name: string): Promise<{ path: string; size: number }> {
  const backup = await describe(server, name)
  return { path: join(paths.backups(server.id), backup.name), size: backup.size }
}

export async function deleteBackup(server: ServerDefinition, name: string) {
  const { path } = await backupPath(server, name)
  await rm(path, { force: true })
}

const run = promisify(execFile)

export type RestoreResult = { world: string; restored: string[]; trashed: string[] }

/**
 * Ripristina un backup (server spento): il mondo attuale (.wld, .twld e i loro .bak) va nel cestino del server,
 * i file del backup prendono il suo posto nella stessa cartella e serverconfig.txt punta al mondo ripristinato.
 */
export async function restoreBackup(server: ServerDefinition, name: string, manager: ServerManager): Promise<RestoreResult> {
  if (running.has(server.id)) throw new BackupError('C\'è già un backup o un ripristino in corso per questo server', 409)
  running.add(server.id)
  const work = join(paths.tmp(), `restore-${randomBytes(4).toString('hex')}`)
  try {
    const status = await manager.status(server)
    if (status.state !== 'stopped' || status.operation) throw new BackupError('Spegni il server prima di ripristinare un backup', 409)
    const { path } = await backupPath(server, name)

    // -j: solo i nomi dei file, niente percorsi (nessun file può finire fuori dalla cartella)
    await mkdir(work, { recursive: true })
    await run('unzip', ['-qq', '-j', '-o', path, '-d', work], { maxBuffer: 1024 * 1024 }).catch(() => {
      throw new BackupError('Il backup è danneggiato: impossibile estrarlo', 422)
    })
    const files = (await readdir(work)).filter((f) => /^[^/\\]+\.(wld|twld)$/i.test(f))
    const worlds = files.filter((f) => /\.wld$/i.test(f))
    if (worlds.length !== 1) throw new BackupError('Il backup non contiene un mondo (.wld)', 422)
    const wld = worlds[0]
    const base = wld.replace(/\.wld$/i, '')
    // Il .twld va solo con il suo mondo
    const restored = files.filter((f) => f === wld || f.toLowerCase() === `${base.toLowerCase()}.twld`)

    const { world: current } = await readServerConfig(server.configPath)
    const dir = current ? dirname(current) : join(server.saveDir, 'Worlds')
    const target = join(dir, wld)
    await mkdir(dir, { recursive: true })
    const trashed = current ? await trashWorld(server, current, 'replaced') : []
    // Un mondo con lo stesso nome del backup (diverso da quello attuale) non va sovrascritto senza lasciarne copia
    if (target !== current) trashed.push(...(await trashWorld(server, target, 'replaced')))

    for (const file of restored) {
      const tmp = join(dir, `.${file}.${randomBytes(4).toString('hex')}.tmp`)
      await copyFile(join(work, file), tmp)
      await rename(tmp, join(dir, file))
    }

    if (target !== current) {
      const text = await readFile(server.configPath, 'utf8').catch(() => '')
      const tmp = `${server.configPath}.${randomBytes(4).toString('hex')}.tmp`
      await writeFile(tmp, applyServerConfig(text, { world: target, worldname: base }))
      await rename(tmp, server.configPath)
    }
    return { world: base, restored, trashed }
  } finally {
    running.delete(server.id)
    await rm(work, { recursive: true, force: true })
  }
}

/** Tiene solo gli ultimi config.backupKeep backup automatici. */
async function pruneAutomatic(server: ServerDefinition) {
  const automatic = (await listBackups(server)).filter((b) => b.auto)
  for (const old of automatic.slice(Math.max(0, config.backupKeep))) await deleteBackup(server, old.name)
}

// --- Backup giornaliero -----------------------------------------------------------------------

/** Prossimo momento HH:MM (ora locale) dopo `now`; null se "off" o non valido. */
export function nextRun(time: string, now = new Date()): Date | null {
  const match = time.match(/^(\d{1,2}):(\d{2})$/)
  if (!match || +match[1] > 23 || +match[2] > 59) return null
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +match[1], +match[2], 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)
  return next
}

type Log = { info: (m: string) => void; warn: (m: string) => void }

/** Esegue il backup automatico di tutti i server che hanno un mondo. */
export async function runDailyBackups(manager: ServerManager, log: Log) {
  for (const server of await loadServers()) {
    try {
      const { backup, saved, running: on } = await createBackup(server, manager, true)
      log.info(`Backup automatico di ${server.name}: ${backup.name}${on && !saved ? ' (salvataggio non confermato: usato l\'ultimo su disco)' : ''}`)
    } catch (err) {
      if (err instanceof BackupError && err.status === 409) continue // senza mondo o già in corso
      log.warn(`Backup automatico di ${server.name} non riuscito: ${(err as Error).message}`)
    }
  }
}

/** Pianifica il backup giornaliero (ricalcolato ogni volta: segue anche i cambi di ora legale). */
export function scheduleDailyBackups(manager: ServerManager, log: Log) {
  const plan = () => {
    const next = nextRun(config.backupTime)
    if (!next) return
    const timer = setTimeout(() => {
      runDailyBackups(manager, log)
        .catch((err) => log.warn(`Backup automatici: ${(err as Error).message}`))
        .finally(plan)
    }, next.getTime() - Date.now())
    timer.unref()
  }
  if (!nextRun(config.backupTime)) {
    if (config.backupTime !== 'off') log.warn(`AGENT_BACKUP_TIME non valido ("${config.backupTime}"): backup automatici disattivati`)
    return
  }
  log.info(`Backup automatici dei mondi ogni giorno alle ${config.backupTime} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`)
  plan()
}

/** Informazioni sul backup automatico per il pannello. */
export const backupSchedule = () => ({
  time: nextRun(config.backupTime) ? config.backupTime : null,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  keep: config.backupKeep,
  next: nextRun(config.backupTime)?.toISOString() ?? null,
})

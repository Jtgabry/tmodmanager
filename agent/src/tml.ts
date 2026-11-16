import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, chmod, cp, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { config } from './config.js'
import { paths } from './paths.js'
import type { ServerManager } from './manager.js'
import { loadServers, type ServerDefinition } from './registry.js'
import { parseTmlVersion } from './serverConfig.js'

/**
 * Installazioni di tModLoader e loro aggiornamento.
 *
 * Aggiornamento (stessa procedura fatta a mano):
 *  1. download di tModLoader.zip della versione scelta da GitHub (verifica sha256)
 *  2. estrazione in <installDir>.new
 *  3. si riportano nella nuova cartella i file non presenti nella release (dotnet/, log, dati delle mod…)
 *     e le configurazioni (serverconfig*.txt, banlist.txt)
 *  4. si spengono i server che usano quell'installazione (con "exit": il mondo viene salvato)
 *  5. <installDir> → <installDir>-v<vecchia versione> (backup), <installDir>.new → <installDir>
 *  6. si riaccendono i server che erano accesi
 * Il ripristino di un backup usa gli stessi passi 3–6.
 */

const run = promisify(execFile)
const VERSION_FILE = '.tmodmanager-version'
/** Elenco dei file di primo livello della release (per distinguerli da dati e runtime aggiunti dopo). */
const RELEASE_FILE = '.tmodmanager-release-files'
const BACKUPS_TO_KEEP = 2
const ALWAYS_KEEP = /^(serverconfig.*\.txt|banlist\.txt)$/i

export class TmlError extends Error {
  constructor(
    message: string,
    public readonly status: 404 | 409 | 422 | 502 = 422,
  ) {
    super(message)
  }
}

export const installationId = (dir: string) => createHash('sha1').update(dir).digest('hex').slice(0, 8)

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

/** Versione installata: dal file scritto dall'aggiornamento, altrimenti dalla prima riga del log del server. */
export async function installedVersion(dir: string): Promise<string | null> {
  try {
    const v = (await readFile(join(dir, VERSION_FILE), 'utf8')).trim()
    if (v) return v
  } catch {
    // installazione non fatta dal pannello
  }
  try {
    const file = await open(join(dir, 'tModLoader-Logs', 'server.log'))
    try {
      const { buffer, bytesRead } = await file.read({ buffer: Buffer.alloc(512) })
      return parseTmlVersion(buffer.toString('utf8', 0, bytesRead))
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

/** Confronto tra versioni "2026.09.3.1" (numerico per parti). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export type Backup = { path: string; version: string | null; modifiedAt: string }

/** Cartelle di backup accanto all'installazione: <installDir>-v<versione>. */
export async function listBackups(installDir: string): Promise<Backup[]> {
  const parent = dirname(installDir)
  const prefix = `${basename(installDir)}-v`
  const backups: Backup[] = []
  for (const name of await readdir(parent).catch(() => [] as string[])) {
    if (!name.startsWith(prefix)) continue
    const path = join(parent, name)
    const info = await stat(path).catch(() => null)
    if (!info?.isDirectory() || !(await exists(join(path, 'tModLoader.dll')))) continue
    backups.push({ path, version: (await installedVersion(path)) ?? name.slice(prefix.length), modifiedAt: info.mtime.toISOString() })
  }
  return backups.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
}

// --- Release da GitHub ------------------------------------------------------------------------

export type Release = {
  version: string
  prerelease: boolean
  publishedAt: string
  url: string
  downloadUrl: string
  size: number
  sha256: string | null
}

let releasesCache: { at: number; releases: Release[] } | null = null

type GithubRelease = {
  tag_name: string
  draft: boolean
  prerelease: boolean
  published_at: string
  html_url: string
  assets: { name: string; size: number; browser_download_url: string; digest?: string | null }[]
}

export async function listReleases(force = false): Promise<Release[]> {
  if (!force && releasesCache && Date.now() - releasesCache.at < 10 * 60 * 1000) return releasesCache.releases
  let response: Response
  try {
    response = await fetch(`https://api.github.com/repos/${config.tmlRepository}/releases?per_page=15`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'tmodmanager-agent' },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    throw new TmlError(`GitHub non raggiungibile: ${(err as Error).message}`, 502)
  }
  if (!response.ok) throw new TmlError(`GitHub ha risposto ${response.status}`, 502)
  const data = (await response.json()) as GithubRelease[]
  const releases = data
    .filter((r) => !r.draft)
    .flatMap((r): Release[] => {
      const asset = r.assets.find((a) => a.name === 'tModLoader.zip')
      if (!asset) return []
      return [
        {
          version: r.tag_name.replace(/^v/, ''),
          prerelease: r.prerelease,
          publishedAt: r.published_at,
          url: r.html_url,
          downloadUrl: asset.browser_download_url,
          size: asset.size,
          sha256: asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null,
        },
      ]
    })
  releasesCache = { at: Date.now(), releases }
  return releases
}

// --- Job di aggiornamento ---------------------------------------------------------------------

export type JobPhase = 'download' | 'extract' | 'prepare' | 'stopping' | 'swap' | 'starting' | 'done' | 'error'

export type Job = {
  installDir: string
  /** install = prima installazione (la cartella non esisteva). */
  kind: 'install' | 'update' | 'rollback'
  fromVersion: string | null
  toVersion: string | null
  phase: JobPhase
  progress: number | null
  message: string
  startedAt: string
  finishedAt: string | null
  error: string | null
  restarted: string[]
}

const jobs = new Map<string, Job>()

export type Installation = {
  id: string
  path: string
  /** L'installazione predefinita del pannello (data/tmodloader/tModLoader). */
  managed: boolean
  /** false = cartella prevista ma tModLoader non ancora installato (si installa dal pannello). */
  installed: boolean
  version: string | null
  servers: { id: string; name: string }[]
  backups: Backup[]
  job: Job | null
}

export const isInstalled = (dir: string) => exists(join(dir, 'start-tModLoaderServer.sh'))

/**
 * Installazioni usate dai server, più quella predefinita del pannello: questa compare anche se non
 * è ancora installata quando non ce ne sono altre (macchina nuova) o mentre la si sta installando.
 */
export async function listInstallations(): Promise<Installation[]> {
  const servers = await loadServers()
  const managed = paths.tmlInstall()
  const dirs = [...new Set(servers.map((s) => s.installDir))]
  if (!dirs.includes(managed) && (dirs.length === 0 || (await isInstalled(managed)) || jobs.has(managed))) dirs.unshift(managed)
  return Promise.all(
    dirs.map(async (path) => ({
      id: installationId(path),
      path,
      managed: path === managed,
      installed: await isInstalled(path),
      version: await installedVersion(path),
      servers: servers.filter((s) => s.installDir === path).map((s) => ({ id: s.id, name: s.name })),
      backups: await listBackups(path),
      job: jobs.get(path) ?? null,
    })),
  )
}

export async function findInstallation(id: string): Promise<Installation> {
  const found = (await listInstallations()).find((i) => i.id === id)
  if (!found) throw new TmlError('Installazione non trovata', 404)
  return found
}

const busy = (job: Job | undefined) => job !== undefined && job.phase !== 'done' && job.phase !== 'error'

/** Avvia l'aggiornamento (o il ripristino di un backup) in background. Lo stato si segue con listInstallations(). */
export async function startJob(
  installation: Installation,
  target: { version: string } | { backup: string },
  restartServers: boolean,
  manager: ServerManager,
) {
  const dir = installation.path
  if (busy(jobs.get(dir))) throw new TmlError('C\'è già un aggiornamento in corso per questa installazione', 409)

  let release: Release | null = null
  let backup: Backup | null = null
  if ('version' in target) {
    release = (await listReleases()).find((r) => r.version === target.version) ?? null
    if (!release) throw new TmlError(`Versione ${target.version} non trovata tra le release di tModLoader`, 404)
    if (installation.installed && installation.version === release.version) throw new TmlError(`La versione ${release.version} è già installata`, 409)
  } else {
    if (!installation.installed) throw new TmlError('tModLoader non è installato: scegli una versione da installare', 409)
    backup = installation.backups.find((b) => b.path === target.backup) ?? null
    if (!backup) throw new TmlError('Backup non trovato', 404)
  }

  // I server devono girare nella sessione gestita, altrimenti non si possono spegnere in modo pulito
  const servers = (await loadServers()).filter((s) => s.installDir === dir)
  const statuses = await Promise.all(servers.map((s) => manager.status(s)))
  const unmanaged = statuses.filter((s) => s.state !== 'stopped' && !s.managed)
  if (unmanaged.length) {
    throw new TmlError(`Server accesi fuori dal pannello: ${unmanaged.map((s) => s.name).join(', ')}. Spegnili prima.`, 409)
  }
  const busyServer = statuses.find((s) => s.operation)
  if (busyServer) throw new TmlError(`Operazione in corso su ${busyServer.name}: riprova tra poco`, 409)

  const job: Job = {
    installDir: dir,
    kind: !installation.installed ? 'install' : release ? 'update' : 'rollback',
    fromVersion: installation.installed ? installation.version : null,
    toVersion: release?.version ?? backup?.version ?? null,
    phase: release ? 'download' : 'prepare',
    progress: null,
    message: release ? `Download di tModLoader ${release.version}…` : 'Preparazione del backup…',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    restarted: [],
  }
  jobs.set(dir, job)
  // Per tutta la durata, niente avvii/spegnimenti dal pannello dei server di questa installazione
  manager.blockInstall(dir, 'Aggiornamento di tModLoader in corso: riprova quando è finito')
  runJob(job, servers, release, backup, restartServers, manager)
    .catch((err: Error) => {
      job.phase = 'error'
      job.error = err.message
      job.message = 'Aggiornamento non riuscito'
      job.finishedAt = new Date().toISOString()
    })
    .finally(() => manager.unblockInstall(dir))
  return job
}

async function download(release: Release, file: string, job: Job) {
  const response = await fetch(release.downloadUrl, { headers: { 'User-Agent': 'tmodmanager-agent' }, redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`Download non riuscito (HTTP ${response.status})`)
  const total = Number(response.headers.get('content-length')) || release.size
  let received = 0
  const hash = createHash('sha256')
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      received += chunk.length
      hash.update(chunk)
      job.progress = total ? Math.min(1, received / total) : null
      done(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), counter, createWriteStream(file))
  if (release.sha256 && hash.digest('hex') !== release.sha256) throw new Error('Il file scaricato non corrisponde (sha256 diverso)')
}

/**
 * Copia nella nuova installazione ciò che non fa parte della release (runtime .NET scaricato al primo
 * avvio, log, dati salvati dalle mod…) più le configurazioni, che vincono sempre su quelle della release.
 */
async function carryOver(from: string, to: string) {
  let releaseFiles = new Set<string>()
  try {
    releaseFiles = new Set(JSON.parse(await readFile(join(from, RELEASE_FILE), 'utf8')) as string[])
  } catch {
    // installazione non fatta dal pannello: si copia tutto ciò che manca
  }
  for (const name of await readdir(from)) {
    if (name === VERSION_FILE || name === RELEASE_FILE) continue
    const keep = ALWAYS_KEEP.test(name)
    if (!keep && (releaseFiles.has(name) || (await exists(join(to, name))))) continue
    await run('cp', ['-a', '--', join(from, name), to])
  }
}

async function runJob(
  job: Job,
  servers: ServerDefinition[],
  release: Release | null,
  backup: Backup | null,
  restartServers: boolean,
  manager: ServerManager,
) {
  const dir = job.installDir
  const staging = `${dir}.new`
  const work = paths.tmp()
  const zip = join(work, `tModLoader-${release?.version ?? 'backup'}.zip`)
  await rm(staging, { recursive: true, force: true })
  const stopped: ServerDefinition[] = []

  try {
    if (release) {
      await mkdir(work, { recursive: true })
      await download(release, zip, job)

      job.phase = 'extract'
      job.progress = null
      job.message = 'Estrazione…'
      await mkdir(staging, { recursive: true })
      await run('unzip', ['-q', zip, '-d', staging], { maxBuffer: 16 * 1024 * 1024 })
      if (!(await exists(join(staging, 'tModLoader.dll'))) || !(await exists(join(staging, 'start-tModLoaderServer.sh')))) {
        throw new Error('Lo zip scaricato non sembra un\'installazione di tModLoader')
      }
      const files = await readdir(staging)
      for (const name of files) if (name.endsWith('.sh')) await chmod(join(staging, name), 0o755)
      await writeFile(join(staging, VERSION_FILE), `${release.version}\n`)
      await writeFile(join(staging, RELEASE_FILE), `${JSON.stringify(files)}\n`)
    } else if (backup) {
      // Il backup viene usato così com'è (rinominato al posto dell'installazione attuale)
      await run('cp', ['-a', '--', backup.path, staging])
      await rm(join(staging, VERSION_FILE), { force: true })
      if (backup.version) await writeFile(join(staging, VERSION_FILE), `${backup.version}\n`)
    }

    if (job.kind === 'install') {
      // Prima installazione: niente da copiare, niente server da spegnere
      job.phase = 'swap'
      job.message = 'Installazione…'
      await mkdir(dirname(dir), { recursive: true })
      await rename(staging, dir)
    } else {
      job.phase = 'prepare'
      job.message = 'Copia di configurazioni, runtime .NET e dati dall\'installazione attuale…'
      await carryOver(dir, staging)

      job.phase = 'stopping'
      for (const server of servers) {
        const status = await manager.status(server)
        if (status.state === 'stopped') continue
        job.message = `Spegnimento di ${server.name} (salvataggio del mondo)…`
        await manager.runBlocking(server, 'stop')
        stopped.push(server)
      }

      job.phase = 'swap'
      job.message = 'Sostituzione dei file…'
      let backupPath = `${dir}-v${job.fromVersion ?? 'precedente'}`
      for (let i = 2; await exists(backupPath); i++) backupPath = `${dir}-v${job.fromVersion ?? 'precedente'}-${i}`
      await rename(dir, backupPath)
      try {
        await rename(staging, dir)
      } catch (err) {
        await rename(backupPath, dir) // rimette a posto l'installazione di prima
        throw err
      }
      if (backup) await rm(backup.path, { recursive: true, force: true }) // il backup ripristinato ora è l'installazione
    }

    if (restartServers) {
      job.phase = 'starting'
      for (const server of stopped) {
        job.message = `Avvio di ${server.name}…`
        await manager.runBlocking(server, 'start')
        job.restarted.push(server.id)
      }
    }

    // Si tengono solo gli ultimi backup
    for (const old of (await listBackups(dir)).slice(BACKUPS_TO_KEEP)) await rm(old.path, { recursive: true, force: true })

    job.phase = 'done'
    job.progress = null
    job.message =
      stopped.length && !restartServers
        ? `Installata la versione ${job.toVersion}. I server spenti per l'aggiornamento vanno riaccesi a mano.`
        : `Installata la versione ${job.toVersion}.`
    job.finishedAt = new Date().toISOString()
  } catch (err) {
    await rm(staging, { recursive: true, force: true })
    // Se l'errore è arrivato dopo lo spegnimento, si prova a riaccendere i server (con la versione rimasta)
    if (restartServers) {
      for (const server of stopped) {
        if (job.restarted.includes(server.id)) continue
        await manager.runBlocking(server, 'start').then(
          () => job.restarted.push(server.id),
          () => undefined,
        )
      }
    }
    throw err
  } finally {
    await rm(zip, { force: true })
  }
}

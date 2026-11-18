import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, chmod, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { config } from './config.js'
import {
  assemblyGameVersion,
  assemblyVersion,
  compareVersions,
  type Game,
  gameLabel,
  readWorldRelease,
  TERRARIA_BINARY,
  terrariaCode,
  terrariaVersionFromCode,
  TML_ASSEMBLY,
  TML_START_SCRIPT,
  TSHOCK_ASSEMBLY,
  TSHOCK_BINARY,
  WORLD_RELEASES,
} from './games.js'
import { paths } from './paths.js'
import type { ServerManager } from './manager.js'
import { loadServers, type ServerDefinition } from './registry.js'
import { parseTmlVersion, readServerConfig } from './serverConfig.js'

export { compareVersions }

/**
 * Installazioni di Terraria (dedicated server vanilla), TShock e tModLoader, e loro aggiornamento.
 *
 * Aggiornamento (stessa procedura fatta a mano):
 *  1. download dello zip della versione scelta (tModLoader e TShock: GitHub, con verifica sha256; Terraria: terraria.org)
 *  2. estrazione in <installDir>.new
 *  3. si riportano nella nuova cartella i file non presenti nella release (dotnet/, log, dati delle mod…)
 *     e le configurazioni (serverconfig*.txt, banlist.txt). TShock: se il runtime .NET che richiede
 *     non c'è, lo si scarica in dotnet/ (lo script di TShock lo cercherebbe su un sito di Microsoft dismesso)
 *  4. si spengono i server che usano quell'installazione (con "exit": il mondo viene salvato)
 *  5. <installDir> → <installDir>-v<vecchia versione> (backup), <installDir>.new → <installDir>
 *  6. si riaccendono i server che erano accesi
 * Il ripristino di un backup usa gli stessi passi 3–6.
 */

const run = promisify(execFile)
const VERSION_FILE = '.tmodmanager-version'
/** Elenco dei file di primo livello della release (per distinguerli da dati e runtime aggiunti dopo). */
const RELEASE_FILE = '.tmodmanager-release-files'
/** Versione dei mondi salvati da questa installazione, imparata dai server che la usano. */
const WORLD_RELEASE_FILE = '.tmodmanager-world-release'
const PANEL_FILES = new Set([VERSION_FILE, RELEASE_FILE, WORLD_RELEASE_FILE])
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

/** Versione aggiuntiva di Terraria (data/terraria/versions/<versione>): fissa, si aggiunge e si rimuove. */
export const isPinned = (dir: string) => dirname(dir) === paths.terrariaVersions()

/** Tipo di un'installazione dai suoi file; se non è (ancora) installata, dalla cartella. */
export async function installationKind(dir: string): Promise<Game> {
  if (await exists(join(dir, TSHOCK_BINARY))) return 'tshock'
  if (await exists(join(dir, TERRARIA_BINARY))) return 'terraria'
  if (await exists(join(dir, TML_ASSEMBLY))) return 'tmodloader'
  const name = basename(dir).toLowerCase()
  if (dir === paths.tshockInstall() || name.startsWith('tshock')) return 'tshock'
  return dir === paths.terrariaInstall() || isPinned(dir) || name.startsWith('terraria') ? 'terraria' : 'tmodloader'
}

/** "6.2.1.0" (FileVersion) → "6.2.1", come i tag delle release. */
const trimRevision = (version: string) => version.replace(/^(\d+\.\d+\.\d+)\.0$/, '$1')

/** Versione installata: dal file scritto dall'aggiornamento, altrimenti (tModLoader) dalla prima riga del log del server. */
export async function installedVersion(dir: string): Promise<string | null> {
  try {
    const v = (await readFile(join(dir, VERSION_FILE), 'utf8')).trim()
    if (v) return v
  } catch {
    // installazione non fatta dal pannello
  }
  if (await exists(join(dir, TERRARIA_BINARY))) return assemblyGameVersion(dir, 'terraria')
  if (await exists(join(dir, TSHOCK_BINARY))) {
    const version = await assemblyVersion(join(dir, TSHOCK_ASSEMBLY))
    return version && trimRevision(version)
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

/** Versione di Terraria dell'installazione: per il vanilla è la versione installata, per TShock e tModLoader quella su cui si basano. */
export async function gameVersion(dir: string, kind: Game): Promise<string | null> {
  if (kind === 'terraria') {
    const version = await installedVersion(dir)
    if (version) return version
  }
  return assemblyGameVersion(dir, kind)
}

/**
 * Versione dei mondi che l'installazione sa aprire (= quella con cui li salva): imparata dai mondi
 * salvati dai suoi server, altrimenti dalla tabella delle versioni di Terraria. null = sconosciuta.
 */
export async function installationWorldRelease(dir: string, version: string | null): Promise<number | null> {
  try {
    const learned = Number((await readFile(join(dir, WORLD_RELEASE_FILE), 'utf8')).trim())
    if (Number.isInteger(learned) && learned > 0) return learned
  } catch {
    // non ancora imparata
  }
  return version ? (WORLD_RELEASES[version] ?? null) : null
}

/** Dopo uno spegnimento pulito (il mondo è appena stato salvato) si annota la versione con cui l'installazione salva. */
export async function recordWorldRelease(server: ServerDefinition) {
  const { world } = await readServerConfig(server.configPath)
  if (!world) return
  const info = await stat(world).catch(() => null)
  // Solo se il mondo è stato davvero salvato adesso
  if (!info || Date.now() - info.mtimeMs > 5 * 60 * 1000) return
  const release = await readWorldRelease(world)
  if (release === null || !(await exists(server.installDir))) return
  await writeFile(join(server.installDir, WORLD_RELEASE_FILE), `${release}\n`)
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
    if (!info?.isDirectory() || !(await isInstalled(path))) continue
    backups.push({ path, version: (await installedVersion(path)) ?? name.slice(prefix.length), modifiedAt: info.mtime.toISOString() })
  }
  return backups.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
}

// --- Release ----------------------------------------------------------------------------------

export type Release = {
  version: string
  /** Versione di Terraria (TShock: quella supportata; tModLoader: null, si sa solo dopo l'installazione). */
  gameVersion: string | null
  prerelease: boolean
  /** null per Terraria: terraria.org non dà la data. */
  publishedAt: string | null
  url: string
  downloadUrl: string
  /** null se non nota prima del download. */
  size: number | null
  sha256: string | null
  /** Versione dei mondi salvati da questa versione, se nota. */
  worldRelease: number | null
}

const releasesCache = new Map<Game, { at: number; releases: Release[] }>()

type GithubRelease = {
  tag_name: string
  name: string | null
  draft: boolean
  prerelease: boolean
  published_at: string
  html_url: string
  assets: { name: string; size: number; browser_download_url: string; digest?: string | null }[]
}

async function fetchJson(url: string, source: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'tmodmanager-agent' },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    throw new TmlError(`${source} non raggiungibile: ${(err as Error).message}`, 502)
  }
  if (!response.ok) throw new TmlError(`${source} ha risposto ${response.status}`, 502)
  return response.json()
}

async function fetchTmlReleases(): Promise<Release[]> {
  const data = (await fetchJson(`${config.githubApi}/repos/${config.tmlRepository}/releases?per_page=15`, 'GitHub')) as GithubRelease[]
  return data
    .filter((r) => !r.draft)
    .flatMap((r): Release[] => {
      const asset = r.assets.find((a) => a.name === 'tModLoader.zip')
      if (!asset) return []
      return [
        {
          version: r.tag_name.replace(/^v/, ''),
          gameVersion: null,
          prerelease: r.prerelease,
          publishedAt: r.published_at,
          url: r.html_url,
          downloadUrl: asset.browser_download_url,
          size: asset.size,
          sha256: asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null,
          // tModLoader: dipende dalla versione di Terraria su cui è basato, nota solo dopo l'installazione
          worldRelease: null,
        },
      ]
    })
}

/** Architettura per i download di TShock e .NET (l'immagine Docker è solo x86_64). */
const linuxRid = () => (process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64')

/**
 * Release di TShock: uno zip per piattaforma ("TShock-6.2.1-for-Terraria-1.4.5.8-linux-x64-Release.zip",
 * nelle beta "TShock-Beta-linux-x64-Release.zip"); la versione di Terraria sta nel titolo della release.
 */
export function parseTshockReleases(data: GithubRelease[], rid = linuxRid()): Release[] {
  return data
    .filter((r) => !r.draft)
    .flatMap((r): Release[] => {
      const asset = r.assets.find((a) => a.name.endsWith(`-${rid}-Release.zip`))
      if (!asset) return []
      const gameVersion = (r.name ?? '').match(/Terraria (\d+(?:\.\d+){2,4})/)?.[1] ?? asset.name.match(/-for-Terraria-([\d.]+?)-/)?.[1] ?? null
      return [
        {
          version: r.tag_name.replace(/^v/, ''),
          gameVersion,
          prerelease: r.prerelease,
          publishedAt: r.published_at,
          url: r.html_url,
          downloadUrl: asset.browser_download_url,
          size: asset.size,
          sha256: asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null,
          worldRelease: gameVersion ? (WORLD_RELEASES[gameVersion] ?? null) : null,
        },
      ]
    })
}

async function fetchTshockReleases(): Promise<Release[]> {
  return parseTshockReleases((await fetchJson(`${config.githubApi}/repos/${config.tshockRepository}/releases?per_page=15`, 'GitHub')) as GithubRelease[])
}

/** Release di Terraria con una certa versione (terraria.org tiene scaricabili anche le versioni vecchie). */
export function terrariaRelease(version: string): Release | null {
  const code = terrariaCode(version)
  if (!code) return null
  return {
    version,
    gameVersion: version,
    prerelease: false,
    publishedAt: null,
    url: `https://terraria.wiki.gg/wiki/${version}`,
    downloadUrl: `${config.terrariaApi}/download/pc-dedicated-server/terraria-server-${code}.zip`,
    size: null,
    sha256: null,
    worldRelease: WORLD_RELEASES[version] ?? null,
  }
}

/** terraria.org indica solo l'ultima versione; le altre della tabella si offrono comunque (più recenti prima). */
async function fetchTerrariaReleases(): Promise<Release[]> {
  const names = (await fetchJson(`${config.terrariaApi}/get/dedicated-servers-names`, 'terraria.org')) as unknown
  const versions = new Set<string>()
  if (Array.isArray(names)) {
    for (const name of names) {
      const code = typeof name === 'string' ? name.match(/^terraria-server-(\d+)\.zip$/)?.[1] : undefined
      const version = code ? terrariaVersionFromCode(code) : null
      if (version) versions.add(version)
    }
  }
  if (!versions.size) throw new TmlError('terraria.org non ha indicato nessuna versione del server', 502)
  for (const version of Object.keys(WORLD_RELEASES)) versions.add(version)
  return [...versions]
    .sort((a, b) => compareVersions(b, a))
    .map((v) => terrariaRelease(v)!)
}

export async function listReleases(kind: Game, force = false): Promise<Release[]> {
  const cached = releasesCache.get(kind)
  if (!force && cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.releases
  const releases = kind === 'terraria' ? await fetchTerrariaReleases() : kind === 'tshock' ? await fetchTshockReleases() : await fetchTmlReleases()
  releasesCache.set(kind, { at: Date.now(), releases })
  for (const listener of releaseListeners) listener(kind, releases)
  return releases
}

type ReleaseListener = (kind: Game, releases: Release[]) => void
const releaseListeners: ReleaseListener[] = []

/** Chiamata a ogni elenco di release scaricato (il controllo degli aggiornamenti ne tiene l'ultima). */
export function onReleases(listener: ReleaseListener) {
  releaseListeners.push(listener)
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

/** Job di installazione/aggiornamento di una cartella (anche finito), se c'è. */
export const installationJob = (dir: string) => jobs.get(dir) ?? null

export type Installation = {
  id: string
  path: string
  kind: Game
  /** Installazione del pannello (data/terraria/Terraria, le versioni aggiuntive di Terraria, data/tshock/TShock, data/tmodloader/tModLoader). */
  managed: boolean
  /** Versione aggiuntiva di Terraria: non si aggiorna, si rimuove quando nessun server la usa. */
  pinned: boolean
  /** false = cartella prevista ma il gioco non è ancora installato (si installa dal pannello). */
  installed: boolean
  version: string | null
  /** Versione di Terraria (per tModLoader: quella su cui è basato). */
  gameVersion: string | null
  /** Versione dei mondi che sa aprire; null se non nota. */
  worldRelease: number | null
  servers: { id: string; name: string; worldRelease: number | null }[]
  backups: Backup[]
  job: Job | null
}

export const isInstalled = async (dir: string) =>
  (await exists(join(dir, TERRARIA_BINARY))) || (await exists(join(dir, TSHOCK_BINARY))) || (await exists(join(dir, TML_START_SCRIPT)))

/** Versioni aggiuntive di Terraria: le cartelle presenti più quelle in installazione (o fallite), dalla più recente. */
async function pinnedDirs(): Promise<string[]> {
  const root = paths.terrariaVersions()
  const names = new Set(await readdir(root).catch(() => [] as string[]))
  for (const dir of jobs.keys()) if (isPinned(dir)) names.add(basename(dir))
  return [...names]
    .filter((name) => /^1(\.\d+){3,5}$/.test(name))
    .sort((a, b) => compareVersions(b, a))
    .map((name) => join(root, name))
}

/**
 * Installazioni usate dai server, più quelle del pannello (anche se non ancora installate):
 * Terraria, le sue versioni aggiuntive, TShock, tModLoader.
 */
export async function listInstallations(): Promise<Installation[]> {
  const servers = await loadServers()
  const managed = [paths.terrariaInstall(), ...(await pinnedDirs()), paths.tshockInstall(), paths.tmlInstall()]
  const dirs = [...new Set([...managed, ...servers.map((s) => s.installDir)])]
  return Promise.all(
    dirs.map(async (path) => {
      const kind = await installationKind(path)
      const installed = await isInstalled(path)
      const version = installed ? await installedVersion(path) : null
      const game = installed ? await gameVersion(path, kind) : null
      return {
        id: installationId(path),
        path,
        kind,
        managed: managed.includes(path),
        pinned: isPinned(path),
        installed,
        version,
        gameVersion: game,
        worldRelease: installed ? await installationWorldRelease(path, game) : null,
        servers: await Promise.all(
          servers
            .filter((s) => s.installDir === path)
            .map(async (s) => ({ id: s.id, name: s.name, worldRelease: await serverWorldRelease(s) })),
        ),
        backups: await listBackups(path),
        job: jobs.get(path) ?? null,
      }
    }),
  )
}

/** Versione del mondo di un server (null se non c'è ancora: viene generato al primo avvio). */
export async function serverWorldRelease(server: ServerDefinition): Promise<number | null> {
  const { world } = await readServerConfig(server.configPath)
  return world ? readWorldRelease(world) : null
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
  const label = gameLabel(installation.kind)
  if (busy(jobs.get(dir))) throw new TmlError('C\'è già un aggiornamento in corso per questa installazione', 409)
  if (installation.pinned && installation.installed) {
    throw new TmlError('Le versioni aggiuntive di Terraria sono fisse: per un\'altra versione aggiungila a parte', 409)
  }

  let release: Release | null = null
  let backup: Backup | null = null
  if ('version' in target) {
    release = (await listReleases(installation.kind).catch(() => [] as Release[])).find((r) => r.version === target.version) ?? null
    // Terraria: anche versioni non in elenco, purché esistano su terraria.org (si vede al download)
    if (!release && installation.kind === 'terraria') release = terrariaRelease(target.version)
    if (!release) throw new TmlError(`Versione ${target.version} non trovata tra le release di ${label}`, 404)
    if (installation.installed && installation.version === release.version) throw new TmlError(`La versione ${release.version} è già installata`, 409)
  } else {
    if (!installation.installed) throw new TmlError(`${label} non è installato: scegli una versione da installare`, 409)
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
    message: release ? `Download di ${label} ${release.version}…` : 'Preparazione del backup…',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    restarted: [],
  }
  jobs.set(dir, job)
  // Per tutta la durata, niente avvii/spegnimenti dal pannello dei server di questa installazione
  manager.blockInstall(dir, `${job.kind === 'install' ? 'Installazione' : 'Aggiornamento'} di ${label} in corso: riprova quando è finito`)
  runJob(job, installation.kind, servers, release, backup, restartServers, manager)
    .catch((err: Error) => {
      job.phase = 'error'
      job.error = err.message
      job.message = 'Aggiornamento non riuscito'
      job.finishedAt = new Date().toISOString()
    })
    .finally(() => manager.unblockInstall(dir))
  return job
}

/** Aggiunge una versione fissa di Terraria (in background, come un'installazione). */
export async function addTerrariaVersion(version: string, manager: ServerManager) {
  const release =
    (await listReleases('terraria').catch(() => [] as Release[])).find((r) => r.version === version) ?? terrariaRelease(version)
  if (!release) throw new TmlError(`Versione di Terraria non valida: ${version}`, 422)
  const all = await listInstallations()
  const same = all.find((i) => i.kind === 'terraria' && i.installed && i.version === version && (i.pinned || i.path === paths.terrariaInstall()))
  if (same) throw new TmlError(`Terraria ${version} è già installato${same.pinned ? '' : ' (è l\'installazione principale)'}`, 409)
  const dir = paths.terrariaVersion(version)
  if (busy(jobs.get(dir))) throw new TmlError(`Terraria ${version} si sta già installando`, 409)
  // Un tentativo fallito in precedenza: si riparte da zero
  await rm(dir, { recursive: true, force: true })
  const installation: Installation = {
    id: installationId(dir),
    path: dir,
    kind: 'terraria',
    managed: true,
    pinned: true,
    installed: false,
    version: null,
    gameVersion: null,
    worldRelease: null,
    servers: [],
    backups: [],
    job: null,
  }
  return startJob(installation, { version: release.version }, false, manager)
}

/** Rimuove una versione aggiuntiva di Terraria (nessun server deve usarla). */
export async function removeInstallation(installation: Installation) {
  if (!installation.pinned) throw new TmlError('Si possono rimuovere solo le versioni aggiuntive di Terraria', 409)
  if (busy(jobs.get(installation.path))) throw new TmlError('Installazione in corso: riprova quando è finita', 409)
  if (installation.servers.length) {
    throw new TmlError(`La usano ancora: ${installation.servers.map((s) => s.name).join(', ')}. Passali a un'altra versione prima.`, 409)
  }
  await rm(installation.path, { recursive: true, force: true })
  jobs.delete(installation.path)
}

type Expected = { size: number | null; hash: { algorithm: 'sha256' | 'sha512'; value: string } | null; notFound: string }

const download = (release: Release, file: string, job: Job) =>
  downloadFile(release.downloadUrl, file, job, {
    size: release.size,
    hash: release.sha256 ? { algorithm: 'sha256', value: release.sha256 } : null,
    notFound: `La versione ${release.version} non è scaricabile (non esiste?)`,
  })

/** Scarica `url` in `file` aggiornando job.progress; se l'hash atteso è noto, lo verifica. */
async function downloadFile(url: string, file: string, job: Job, expected: Expected) {
  const response = await fetch(url, { headers: { 'User-Agent': 'tmodmanager-agent' }, redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(response.status === 404 ? expected.notFound : `Download non riuscito (HTTP ${response.status})`)
  }
  const total = Number(response.headers.get('content-length')) || expected.size || 0
  let received = 0
  const hash = createHash(expected.hash?.algorithm ?? 'sha256')
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      received += chunk.length
      hash.update(chunk)
      job.progress = total ? Math.min(1, received / total) : null
      done(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), counter, createWriteStream(file))
  if (expected.hash && hash.digest('hex') !== expected.hash.value.toLowerCase()) {
    throw new Error(`Il file scaricato non corrisponde (${expected.hash.algorithm} diverso)`)
  }
}

/** Estrae lo zip di una release in `staging` e controlla che sia un'installazione del gioco giusto. */
async function extractRelease(kind: Game, zip: string, staging: string, work: string) {
  if (kind === 'tshock') return extractTshock(zip, staging, work)
  if (kind === 'tmodloader') {
    await mkdir(staging, { recursive: true })
    await run('unzip', ['-q', zip, '-d', staging], { maxBuffer: 16 * 1024 * 1024 })
    if (!(await exists(join(staging, TML_ASSEMBLY))) || !(await exists(join(staging, TML_START_SCRIPT)))) {
      throw new Error('Lo zip scaricato non sembra un\'installazione di tModLoader')
    }
    return
  }
  // Terraria: <versione>/{Linux,Windows,Mac}/… → serve solo Linux/
  const out = join(work, `terraria-${randomBytes(4).toString('hex')}`)
  try {
    await mkdir(out, { recursive: true })
    await run('unzip', ['-q', zip, '-d', out], { maxBuffer: 16 * 1024 * 1024 })
    let linux: string | null = null
    for (const top of await readdir(out)) {
      if (await exists(join(out, top, 'Linux', TERRARIA_BINARY))) linux = join(out, top, 'Linux')
    }
    if (!linux) throw new Error('Lo zip scaricato non contiene il server Linux di Terraria')
    await mkdir(dirname(staging), { recursive: true })
    await rename(linux, staging)
    for (const name of [TERRARIA_BINARY, 'TerrariaServer']) await chmod(join(staging, name), 0o755).catch(() => undefined)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
}

/** TShock: lo zip contiene un .tar (per conservare i permessi) con l'installazione. */
async function extractTshock(zip: string, staging: string, work: string) {
  const out = join(work, `tshock-${randomBytes(4).toString('hex')}`)
  try {
    await mkdir(out, { recursive: true })
    await run('unzip', ['-q', zip, '-d', out], { maxBuffer: 16 * 1024 * 1024 })
    await mkdir(staging, { recursive: true })
    const tars = (await readdir(out)).filter((name) => name.endsWith('.tar'))
    if (tars.length) {
      for (const tar of tars) await run('tar', ['-xf', join(out, tar), '-C', staging], { maxBuffer: 16 * 1024 * 1024 })
    } else {
      // Zip senza .tar: i file stanno direttamente nello zip
      for (const name of await readdir(out)) await rename(join(out, name), join(staging, name))
    }
    if (!(await exists(join(staging, TSHOCK_BINARY))) || !(await exists(join(staging, TSHOCK_ASSEMBLY)))) {
      throw new Error('Lo zip scaricato non sembra un\'installazione di TShock')
    }
    for (const name of [TSHOCK_BINARY, 'TShock.Installer']) await chmod(join(staging, name), 0o755).catch(() => undefined)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
}

/** Canale di .NET richiesto da TShock.Server ("9.0"), dal runtimeconfig incorporato nell'eseguibile. */
export async function requiredDotnet(dir: string): Promise<string> {
  const binary = await readFile(join(dir, TSHOCK_BINARY))
  return binary.toString('latin1').match(/"tfm"\s*:\s*"net(\d+\.\d+)"/)?.[1] ?? '9.0'
}

/** Il runtime .NET in <dir>/dotnet ha la versione `channel` (es. "9.0")? */
export async function hasDotnet(dir: string, channel: string): Promise<boolean> {
  if (!(await exists(join(dir, 'dotnet', 'dotnet')))) return false
  const versions = await readdir(join(dir, 'dotnet', 'shared', 'Microsoft.NETCore.App')).catch(() => [] as string[])
  return versions.some((v) => v.startsWith(`${channel}.`))
}

type DotnetReleases = {
  'latest-runtime': string
  releases: { runtime?: { version: string; files: { name: string; rid?: string; url: string; hash?: string }[] } | null }[]
}

/**
 * TShock ha bisogno del runtime .NET (non incluso): si scarica l'ultima versione del canale richiesto
 * in <dir>/dotnet (verificata con lo sha512 pubblicato da Microsoft). Gli aggiornamenti lo riportano
 * nella nuova installazione; si riscarica solo se una nuova TShock chiede un altro canale.
 */
async function ensureDotnet(dir: string, job: Job, work: string) {
  const channel = await requiredDotnet(dir)
  if (await hasDotnet(dir, channel)) return
  job.phase = 'prepare'
  job.progress = null
  job.message = `Download del runtime .NET ${channel}…`
  const meta = (await fetchJson(`${config.dotnetReleases}/${channel}/releases.json`, 'Microsoft (.NET)')) as DotnetReleases
  const version = meta['latest-runtime']
  const rid = linuxRid()
  const file = meta.releases
    .find((r) => r.runtime?.version === version)
    ?.runtime?.files.find((f) => f.rid === rid && f.name.endsWith('.tar.gz'))
  if (!file) throw new Error(`Runtime .NET ${version} per ${rid} non trovato`)
  const archive = join(work, `dotnet-${version}-${randomBytes(4).toString('hex')}.tar.gz`)
  const target = join(dir, 'dotnet.new')
  try {
    await downloadFile(file.url, archive, job, {
      size: null,
      hash: file.hash ? { algorithm: 'sha512', value: file.hash } : null,
      notFound: `Runtime .NET ${version} non scaricabile`,
    })
    job.progress = null
    job.message = `Estrazione del runtime .NET ${version}…`
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
    await run('tar', ['-xzf', archive, '-C', target], { maxBuffer: 16 * 1024 * 1024 })
    await rm(join(dir, 'dotnet'), { recursive: true, force: true })
    await rename(target, join(dir, 'dotnet'))
  } finally {
    await rm(archive, { force: true })
    await rm(target, { recursive: true, force: true })
  }
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
    if (PANEL_FILES.has(name)) continue
    const keep = ALWAYS_KEEP.test(name)
    if (!keep && (releaseFiles.has(name) || (await exists(join(to, name))))) continue
    await run('cp', ['-a', '--', join(from, name), to])
  }
}

async function runJob(
  job: Job,
  kind: Game,
  servers: ServerDefinition[],
  release: Release | null,
  backup: Backup | null,
  restartServers: boolean,
  manager: ServerManager,
) {
  const dir = job.installDir
  const staging = `${dir}.new`
  const work = paths.tmp()
  const zip = join(work, `${kind}-${release?.version ?? 'backup'}.zip`)
  await rm(staging, { recursive: true, force: true })
  await mkdir(work, { recursive: true })
  const stopped: ServerDefinition[] = []

  try {
    if (release) {
      await mkdir(work, { recursive: true })
      await download(release, zip, job)

      job.phase = 'extract'
      job.progress = null
      job.message = 'Estrazione…'
      await extractRelease(kind, zip, staging, work)
      const files = await readdir(staging)
      if (kind === 'tmodloader') for (const name of files) if (name.endsWith('.sh')) await chmod(join(staging, name), 0o755)
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
      if (kind === 'tshock') await ensureDotnet(staging, job, work)
      job.phase = 'swap'
      job.message = 'Installazione…'
      await mkdir(dirname(dir), { recursive: true })
      await rename(staging, dir)
    } else {
      job.phase = 'prepare'
      job.message =
        kind === 'terraria' ? 'Copia delle configurazioni dall\'installazione attuale…' : 'Copia di configurazioni, runtime .NET e dati dall\'installazione attuale…'
      await carryOver(dir, staging)
      if (kind === 'tshock') await ensureDotnet(staging, job, work)

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

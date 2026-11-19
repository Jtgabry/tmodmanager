import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { config } from './config.js'
import { paths } from './paths.js'
import type { ServerDefinition } from './registry.js'
import { readServerConfig } from './serverConfig.js'
import type { RenderJob, WorldFileSource } from './worldFileRender.js'
import { TILE_FORMAT } from './worldTiles.js'

/**
 * Mappa ricavata dal file del mondo (.wld), per tutti i server: si ridisegna quando il file cambia (a ogni
 * salvataggio del mondo) e solo mentre qualcuno guarda la sezione Mondo. Un disegno alla volta, in un
 * worker thread. Su disco: data/servers/<id>/worldmap/ (stesso formato di LiveMap).
 *
 * Con tModLoader i blocchi e i muri delle mod stanno nel .twld accanto al .wld: si leggono anche quelli, con i
 * colori ricavati dalle texture delle mod (modMapColors.ts).
 */

export const worldMapDir = (serverId: string) => join(paths.server(serverId), 'worldmap')
export const mapColorsPath = () => join(config.addonsDir, 'map-colors.json')

/** Un file appena modificato potrebbe essere ancora in scrittura (salvataggio in corso): si aspetta. */
const SETTLE_MS = 3000

type RenderState = { running: boolean; failed: { key: string; message: string } | null }
const states = new Map<string, RenderState>()
let queue: Promise<unknown> = Promise.resolve()

const exists = (path: string) => stat(path).then(() => true, () => false)

/** File del mondo del server: quello di serverconfig.txt, altrimenti <save>/Worlds/<nome>.wld. */
export async function worldFilePath(server: ServerDefinition): Promise<string | null> {
  const settings = await readServerConfig(server.configPath)
  const candidates: string[] = []
  if (settings.world) candidates.push(isAbsolute(settings.world) ? settings.world : join(server.installDir, settings.world))
  if (settings.worldName) candidates.push(join(server.saveDir, 'Worlds', `${settings.worldName}.wld`))
  for (const path of candidates) if (await exists(path)) return path
  return null
}

export type WorldFileMapStatus = {
  /** Il mondo non esiste ancora (verrà creato al primo avvio). */
  missing: boolean
  /** Mancano le tabelle dei colori (in sviluppo: addons/build.sh). */
  noColors: boolean
  /** Disegno in corso (o in coda) per una versione più recente del file. */
  generating: boolean
  /** Ultimo errore di lettura di questa versione del file. */
  error: string | null
  /** Quando il file del mondo è stato salvato (la mappa è di quel momento). */
  savedAt: string | null
}

/**
 * Stato della mappa dal file del mondo; se il file è cambiato dall'ultimo disegno, ne avvia uno nuovo
 * (senza aspettarlo: la pagina vede la mappa precedente finché quella nuova non è pronta).
 */
export async function refreshWorldFileMap(server: ServerDefinition): Promise<WorldFileMapStatus> {
  const status: WorldFileMapStatus = { missing: false, noColors: false, generating: false, error: null, savedAt: null }
  const path = await worldFilePath(server)
  if (!path) return { ...status, missing: true }
  if (!(await exists(mapColorsPath()))) return { ...status, noColors: true }

  const info = await stat(path)
  const twldPath = server.game === 'tmodloader' ? path.replace(/\.wld$/i, '.twld') : null
  const twld = twldPath ? await stat(twldPath).catch(() => null) : null
  const source: WorldFileSource = {
    file: basename(path),
    mtimeMs: Math.round(info.mtimeMs),
    size: info.size,
    twld: twld ? { mtimeMs: Math.round(twld.mtimeMs), size: twld.size } : null,
  }
  const key = sourceKey(source)
  status.savedAt = new Date(source.mtimeMs).toISOString()

  let drawn: WorldFileSource | null = null
  let tileData = 0
  try {
    const manifest = JSON.parse(await readFile(join(worldMapDir(server.id), 'manifest.json'), 'utf8')) as { source?: WorldFileSource; tileData?: number }
    drawn = manifest.source ?? null
    tileData = manifest.tileData ?? 0
  } catch {
    // mai disegnata
  }
  // Stesso file e stesso formato: niente da rifare (una mappa di una versione precedente si ridisegna una volta)
  if (drawn && sourceKey(drawn) === key && tileData === TILE_FORMAT) return status

  const state = states.get(server.id) ?? { running: false, failed: null }
  states.set(server.id, state)
  if (state.running) return { ...status, generating: true }
  if (state.failed?.key === key) return { ...status, error: state.failed.message }
  if (Date.now() - Math.max(info.mtimeMs, twld?.mtimeMs ?? 0) < SETTLE_MS) return { ...status, generating: true }

  state.running = true
  const job: RenderJob = {
    worldPath: path,
    source,
    outDir: worldMapDir(server.id),
    colorsPath: mapColorsPath(),
    twldPath: twld ? twldPath : null,
    modsDir: twld ? join(server.saveDir, 'Mods') : null,
  }
  queue = queue
    .then(() => runWorker(job))
    .then(
      () => {
        state.failed = null
      },
      (err: unknown) => {
        state.failed = { key, message: err instanceof Error ? err.message : String(err) }
      },
    )
    .finally(() => {
      state.running = false
    })
  return { ...status, generating: true }
}

/** Il file (o il .twld accanto) è cambiato dall'ultimo disegno? */
const sourceKey = (s: WorldFileSource) => `${s.file}:${s.mtimeMs}:${s.size}:${s.twld ? `${s.twld.mtimeMs}:${s.twld.size}` : '-'}`

/** Il worker è lo stesso file .ts in sviluppo (tsx) e .js compilato in produzione. */
function runWorker(job: RenderJob): Promise<void> {
  const file = new URL(import.meta.url.endsWith('.ts') ? './worldFileWorker.ts' : './worldFileWorker.js', import.meta.url)
  return new Promise((resolve, reject) => {
    const worker = new Worker(file, { workerData: job, execArgv: process.execArgv })
    let settled = false
    worker.once('message', (m: { ok: boolean; message?: string }) => {
      settled = true
      if (m.ok) resolve()
      else reject(new Error(m.message ?? 'Lettura del mondo non riuscita'))
    })
    worker.once('error', (err) => {
      settled = true
      reject(err)
    })
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`Lettura del mondo interrotta (codice ${code})`))
    })
  })
}

/** Per i test: aspetta la fine dei disegni in corso. */
export const worldFileMapIdle = () => queue.then(() => undefined)

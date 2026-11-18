import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { ADDONS, addonPath } from './addons.js'
import { tshockDataDir, tshockPluginsDir } from './games.js'
import type { ServerDefinition } from './registry.js'

/**
 * Mappa del mondo di un server, per la sezione "Mondo" del pannello.
 *
 * Formato unico, indipendente da chi la produce: una griglia di riquadri PNG (un pixel per tile) con una
 * versione ciascuno, una panoramica ridotta e le posizioni dei giocatori. Oggi l'unica sorgente è l'add-on
 * LiveMap sui server TShock (in tempo reale, scrive in <save>/tshock/map/); in futuro la stessa griglia verrà
 * ricavata dal file del mondo (.wld, e .twld per tModLoader) per gli altri server.
 */

export type MapSource = 'livemap'

/** Perché non c'è una mappa da mostrare. */
export type MapUnavailable =
  /** Server non TShock: serve la lettura del file del mondo (non ancora disponibile). */
  | 'unsupported-game'
  /** L'add-on non è in questa installazione del pannello. */
  | 'addon-missing'
  /** LiveMap c'è ma non è attivo sul server. */
  | 'addon-disabled'
  /** LiveMap attivo ma ancora nessun dato: server da (ri)avviare, o primo disegno in corso. */
  | 'no-data'

const LIVEMAP = ADDONS.find((a) => a.name === 'LiveMap')!

const Manifest = z.object({
  format: z.literal(1),
  world: z.object({
    name: z.string(),
    id: z.number(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    spawnX: z.number(),
    spawnY: z.number(),
    surface: z.number(),
    rock: z.number(),
  }),
  chunkWidth: z.number().int().positive(),
  chunkHeight: z.number().int().positive(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  /** Versione di ogni riquadro, riga per riga (indice = cy * cols + cx); 0 = non ancora disegnato. */
  chunks: z.array(z.number()),
  overview: z.object({ scale: z.number().int().positive(), width: z.number(), height: z.number(), version: z.number() }),
  progress: z.object({ drawn: z.number(), total: z.number() }),
})
export type WorldMapManifest = z.infer<typeof Manifest>

const Player = z.object({
  name: z.string(),
  x: z.number(),
  y: z.number(),
  team: z.number(),
  life: z.number(),
  lifeMax: z.number(),
  dead: z.boolean(),
})
export type MapPlayer = z.infer<typeof Player>

export type WorldMapState = {
  source: MapSource | null
  unavailable: MapUnavailable | null
  /** Solo per i server TShock: l'add-on è disponibile / attivo. */
  liveMap: { available: boolean; enabled: boolean } | null
  /** Quando la mappa è stata aggiornata l'ultima volta (scrittura del manifest). */
  updatedAt: string | null
  manifest: WorldMapManifest | null
  players: MapPlayer[]
  /** Ultimo aggiornamento delle posizioni dei giocatori. */
  playersAt: string | null
}

const liveMapDir = (server: ServerDefinition) => join(tshockDataDir(server.saveDir), 'map')
const exists = (path: string) => stat(path).then(() => true, () => false)

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<{ value: T; mtime: Date } | null> {
  try {
    const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    const parsed = schema.safeParse(JSON.parse(raw))
    return parsed.success ? { value: parsed.data, mtime: info.mtime } : null
  } catch {
    return null
  }
}

/**
 * Stato della mappa. Con `watching` (pagina aperta) segnala a LiveMap che qualcuno la sta guardando:
 * il plugin lavora solo finché il file "viewer" viene toccato (vedi addons/LiveMap).
 */
export async function worldMap(server: ServerDefinition, { watching = false } = {}): Promise<WorldMapState> {
  const empty: WorldMapState = { source: null, unavailable: null, liveMap: null, updatedAt: null, manifest: null, players: [], playersAt: null }
  if (server.game !== 'tshock') return { ...empty, unavailable: 'unsupported-game' }

  const enabled = await exists(join(tshockPluginsDir(server.saveDir), `${LIVEMAP.name}.dll`))
  const liveMap = { available: await exists(addonPath(LIVEMAP)), enabled }
  const dir = liveMapDir(server)
  if (enabled && watching) {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'viewer'), `${new Date().toISOString()}\n`)
  }

  // L'ultima mappa resta visibile anche con il server spento o l'add-on disattivato
  const manifest = await readJson(join(dir, 'manifest.json'), Manifest)
  if (!manifest) {
    return { ...empty, liveMap, unavailable: enabled ? 'no-data' : liveMap.available ? 'addon-disabled' : 'addon-missing' }
  }
  const players = await readJson(join(dir, 'players.json'), z.object({ players: z.array(Player) }))
  return {
    source: 'livemap',
    unavailable: null,
    liveMap,
    updatedAt: manifest.mtime.toISOString(),
    manifest: manifest.value,
    players: players?.value.players ?? [],
    playersAt: players?.mtime.toISOString() ?? null,
  }
}

const COORD = /^\d{1,4}$/

/** PNG di un riquadro (null se non c'è). */
export async function mapChunkPath(server: ServerDefinition, cx: string, cy: string): Promise<string | null> {
  if (server.game !== 'tshock' || !COORD.test(cx) || !COORD.test(cy)) return null
  const path = join(liveMapDir(server), 'chunks', `${Number(cx)}_${Number(cy)}.png`)
  return (await exists(path)) ? path : null
}

export async function mapOverviewPath(server: ServerDefinition): Promise<string | null> {
  if (server.game !== 'tshock') return null
  const path = join(liveMapDir(server), 'overview.png')
  return (await exists(path)) ? path : null
}

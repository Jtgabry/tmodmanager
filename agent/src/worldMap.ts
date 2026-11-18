import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { ADDONS, addonPath } from './addons.js'
import { tshockDataDir, tshockPluginsDir } from './games.js'
import type { ServerDefinition } from './registry.js'
import { refreshWorldFileMap, worldMapDir } from './worldFileMap.js'

/**
 * Mappa del mondo di un server, per la sezione "Mondo" del pannello.
 *
 * Formato unico, indipendente da chi la produce: una griglia di riquadri PNG (un pixel per tile) con una
 * versione ciascuno, una panoramica ridotta e, se ci sono, le posizioni dei giocatori. Due sorgenti:
 *  - livemap: l'add-on LiveMap sui server TShock, in tempo reale (scrive in <save>/tshock/map/);
 *  - world:   il file del mondo (.wld), per tutti i server, aggiornata a ogni salvataggio (worldFileMap.ts).
 * LiveMap, quando è attivo e ha già disegnato, ha la precedenza.
 */

export const MAP_SOURCES = ['livemap', 'world'] as const
export type MapSource = (typeof MAP_SOURCES)[number]

/** Perché non c'è una mappa da mostrare. */
export type MapUnavailable =
  /** Il mondo non esiste ancora (verrà creato al primo avvio del server). */
  | 'no-world'
  /** Mancano i colori della mappa (installazione di sviluppo senza addons/build.sh). */
  | 'no-colors'
  /** Il file del mondo non si è potuto leggere. */
  | 'world-error'
  /** Prima lettura del file del mondo in corso. */
  | 'loading'

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
  /** Mappa dal file del mondo: ridisegno in corso, ultimo errore, salvataggio del mondo. */
  worldFile: { generating: boolean; error: string | null; savedAt: string | null } | null
  /** tModLoader: blocchi e muri delle mod letti dal .twld (quanti tipi, quanti colori dalle texture, errore). */
  modBlocks: { tiles: number; walls: number; fromTextures: number; error: string | null } | null
  /** Quando la mappa è stata aggiornata l'ultima volta (LiveMap: ultima scrittura; file: salvataggio del mondo). */
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
  const state: WorldMapState = {
    source: null, unavailable: null, liveMap: null, worldFile: null, modBlocks: null, updatedAt: null, manifest: null, players: [], playersAt: null,
  }

  if (server.game === 'tshock') {
    const enabled = await exists(join(tshockPluginsDir(server.saveDir), `${LIVEMAP.name}.dll`))
    state.liveMap = { available: await exists(addonPath(LIVEMAP)), enabled }
    if (enabled) {
      const dir = liveMapDir(server)
      if (watching) {
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'viewer'), `${new Date().toISOString()}\n`)
      }
      const manifest = await readJson(join(dir, 'manifest.json'), Manifest)
      if (manifest) {
        const players = await readJson(join(dir, 'players.json'), z.object({ players: z.array(Player) }))
        return {
          ...state,
          source: 'livemap',
          updatedAt: manifest.mtime.toISOString(),
          manifest: manifest.value,
          players: players?.value.players ?? [],
          playersAt: players?.mtime.toISOString() ?? null,
        }
      }
      // LiveMap non ha ancora disegnato (server da riavviare, primo giro): intanto la mappa dal file
    }
  }

  const file = await refreshWorldFileMap(server)
  state.worldFile = { generating: file.generating, error: file.error, savedAt: file.savedAt }
  const manifest = await readJson(
    join(worldMapDir(server.id), 'manifest.json'),
    Manifest.extend({
      source: z.object({ mtimeMs: z.number() }),
      modBlocks: z.object({ tiles: z.number(), walls: z.number(), fromTextures: z.number(), error: z.string().nullable() }).nullable().optional(),
    }),
  )
  if (manifest && !file.missing) {
    const { source, modBlocks, ...rest } = manifest.value
    return { ...state, source: 'world', manifest: rest, modBlocks: modBlocks ?? null, updatedAt: new Date(source.mtimeMs).toISOString() }
  }
  const unavailable: MapUnavailable = file.missing ? 'no-world' : file.noColors ? 'no-colors' : file.error ? 'world-error' : 'loading'
  return { ...state, unavailable }
}

const mapDir = (server: ServerDefinition, source: string) =>
  source === 'livemap' && server.game === 'tshock' ? liveMapDir(server) : source === 'world' ? worldMapDir(server.id) : null

const COORD = /^\d{1,4}$/

/** PNG di un riquadro di una sorgente (null se non c'è). */
export async function mapChunkPath(server: ServerDefinition, source: string, cx: string, cy: string): Promise<string | null> {
  const dir = mapDir(server, source)
  if (!dir || !COORD.test(cx) || !COORD.test(cy)) return null
  const path = join(dir, 'chunks', `${Number(cx)}_${Number(cy)}.png`)
  return (await exists(path)) ? path : null
}

export async function mapOverviewPath(server: ServerDefinition, source: string): Promise<string | null> {
  const dir = mapDir(server, source)
  if (!dir) return null
  const path = join(dir, 'overview.png')
  return (await exists(path)) ? path : null
}

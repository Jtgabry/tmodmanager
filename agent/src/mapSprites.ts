import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { listMods, modsDir } from './mods.js'
import { paths } from './paths.js'
import { encodePngRgba } from './png.js'
import type { ServerDefinition } from './registry.js'
import { readModEntries } from './tmod.js'

/**
 * Sprite dei blocchi e dei muri per la vista ravvicinata della mappa (LiveMap). LiveMap scrive in types.json la
 * texture di ogni tipo delle mod ("CalamityMod/Tiles/Abyss/AbyssGravel"); qui si prende dal .tmod di quella mod
 * (Tiles/Abyss/AbyssGravel.rawimg) e si converte in PNG, una volta sola: poi resta in
 * servers/<id>/sprites/<Mod>/<versione>/. Gli sprite di Terraria per ora non ci sono (non sono sul server).
 */

export const SPRITE_KINDS = ['tiles', 'walls'] as const
export type SpriteKind = (typeof SPRITE_KINDS)[number]

const ModType = z.object({ mod: z.string(), name: z.string(), texture: z.string() })
const Types = z.object({
  // Formato dei dati delle tile (TileData.Format): i tipi sono gli stessi per tutti i formati
  format: z.number().int().positive(),
  vanillaTiles: z.number().int(),
  vanillaWalls: z.number().int(),
  frameImportant: z.array(z.boolean()),
  solid: z.array(z.boolean()),
  modTiles: z.record(z.string(), ModType),
  modWalls: z.record(z.string(), ModType),
})
export type TileTypes = z.infer<typeof Types>

const typesCache = new Map<string, { mtimeMs: number; types: TileTypes }>()

/** types.json di LiveMap (null se manca o non è valido). */
export async function readTileTypes(path: string): Promise<{ types: TileTypes; mtimeMs: number } | null> {
  const info = await stat(path).catch(() => null)
  if (!info) return null
  const hit = typesCache.get(path)
  if (hit?.mtimeMs === info.mtimeMs) return hit
  try {
    const parsed = Types.safeParse(JSON.parse(await readFile(path, 'utf8')))
    if (!parsed.success) return null
    const entry = { mtimeMs: info.mtimeMs, types: parsed.data }
    typesCache.set(path, entry)
    return entry
  } catch {
    return null
  }
}

/** "CalamityMod/Tiles/Abyss/AbyssGravel": nome della mod e percorso nel .tmod; null se non è di una mod. */
const TEXTURE = /^([A-Za-z0-9_]{1,64})\/((?:[A-Za-z0-9_.-]{1,128}\/){0,16}[A-Za-z0-9_.-]{1,128})$/

export function parseTexture(texture: string): { mod: string; path: string } | null {
  const match = TEXTURE.exec(texture)
  if (!match || match[1] === 'Terraria' || match[2].split('/').some((p) => p === '..' || p === '.')) return null
  return { mod: match[1], path: match[2] }
}

/** rawimg di tModLoader: int32 versione (1), larghezza, altezza, poi i pixel RGBA. */
export function rawimgToPng(data: Buffer): Buffer | null {
  if (data.length < 12 || data.readInt32LE(0) !== 1) return null
  const width = data.readInt32LE(4)
  const height = data.readInt32LE(8)
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192 || data.length < 12 + width * height * 4) return null
  return encodePngRgba(data.subarray(12, 12 + width * height * 4), width, height)
}

/** Già convertiti (o non trovati) in questo processo: niente riletture dello stesso .tmod. */
const missing = new Set<string>()

/**
 * PNG dello sprite del tipo indicato, dalla texture della sua mod (null: tipo di Terraria, mod non installata,
 * texture non trovata). `typesPath`: il types.json di LiveMap del server.
 */
export async function spritePng(server: ServerDefinition, typesPath: string, kind: SpriteKind, type: number): Promise<string | null> {
  const entry = await readTileTypes(typesPath)
  const mod = entry && (kind === 'tiles' ? entry.types.modTiles : entry.types.modWalls)[String(type)]
  const texture = mod ? parseTexture(mod.texture) : null
  if (!texture) return null

  const installed = (await listMods(server)).mods.find((m) => m.name === texture.mod)
  if (!installed) return null
  const version = (installed.version ?? '0').replace(/[^0-9A-Za-z.]/g, '')
  const cached = join(paths.server(server.id), 'sprites', texture.mod, version, `${texture.path}.png`)
  if (await stat(cached).then(() => true, () => false)) return cached
  const key = `${server.id}:${texture.mod}@${version}:${texture.path}`
  if (missing.has(key)) return null

  const wanted = new Set([`${texture.path}.rawimg`, `${texture.path}.png`])
  const files = await readModEntries(join(modsDir(server), installed.file), (p) => wanted.has(p), 16 * 1024 * 1024).catch(() => new Map<string, Buffer>())
  const raw = files.get(`${texture.path}.rawimg`)
  const png = raw ? rawimgToPng(raw) : (files.get(`${texture.path}.png`) ?? null)
  if (!png) {
    missing.add(key)
    return null
  }
  await mkdir(dirname(cached), { recursive: true })
  const tmp = `${cached}.${process.pid}.tmp`
  await writeFile(tmp, png)
  await rename(tmp, cached)
  return cached
}

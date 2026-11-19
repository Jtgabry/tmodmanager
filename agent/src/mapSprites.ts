import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { listMods, modsDir } from './mods.js'
import { paths } from './paths.js'
import { encodePngRgba } from './png.js'
import type { ServerDefinition } from './registry.js'
import { compareVersions } from './tml.js'
import { readModEntries } from './tmod.js'
import { readXnbTexture } from './xnb.js'

/**
 * Sprite dei blocchi e dei muri per la vista ravvicinata della mappa (LiveMap). LiveMap scrive in types.json la
 * texture di ogni tipo delle mod ("CalamityMod/Tiles/Abyss/AbyssGravel"); qui si prende dal .tmod di quella mod
 * (Tiles/Abyss/AbyssGravel.rawimg) e si converte in PNG, una volta sola: poi resta in
 * servers/<id>/sprites/<Mod>/<versione>/. Gli sprite di Terraria non sono nel gioco installato sul server:
 * vengono da data/terraria-assets/<versione>/Images/ (Tiles_*.xnb e Wall_*.xnb copiati da un'installazione del
 * gioco), convertiti allo stesso modo in data/terraria-assets/<versione>/png/.
 */

/** tiles e walls: per tipo; treetops e treebranches: chiome e rami degli alberi di Terraria, per stile; liquids: i
 * liquidi di Terraria, per stile (acqua dei vari biomi, lava, miele, shimmer). */
export const SPRITE_KINDS = ['tiles', 'walls', 'treetops', 'treebranches', 'liquids'] as const
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

/** Texture di Terraria disponibili (la versione più recente in data/terraria-assets), oppure null. */
export async function vanillaAssets(): Promise<{ version: string; dir: string } | null> {
  const root = paths.terrariaAssets()
  const versions = (await readdir(root).catch(() => [] as string[])).filter((v) => /^\d+(\.\d+){1,3}$/.test(v)).sort(compareVersions)
  for (const version of versions.reverse()) {
    const dir = join(root, version)
    if (await stat(join(dir, 'Images', 'Tiles_0.xnb')).then(() => true, () => false)) return { version, dir }
  }
  return null
}

const VANILLA_TEXTURE = /^(Tiles|Wall|Tree_Tops|Tree_Branches|Liquid)_\d{1,5}$/

/** PNG di una texture di Terraria ("Tiles_1", "Wall_4", "Tree_Tops_0"), convertita dal .xnb la prima volta. */
export async function vanillaSpritePng(name: string): Promise<string | null> {
  if (!VANILLA_TEXTURE.test(name)) return null
  const assets = await vanillaAssets()
  if (!assets) return null
  const cached = join(assets.dir, 'png', `${name}.png`)
  if (await stat(cached).then(() => true, () => false)) return cached
  const key = `terraria@${assets.version}:${name}`
  if (missing.has(key)) return null
  try {
    const texture = readXnbTexture(await readFile(join(assets.dir, 'Images', `${name}.xnb`)))
    await mkdir(dirname(cached), { recursive: true })
    const tmp = `${cached}.${process.pid}.tmp`
    await writeFile(tmp, encodePngRgba(texture.rgba, texture.width, texture.height))
    await rename(tmp, cached)
    return cached
  } catch {
    missing.add(key)
    return null
  }
}

/** "CalamityMod/Tiles/Abyss/AbyssGravel": nome della mod e percorso nel .tmod; null se non è di una mod. */
/** Già cercati e non trovati (o non convertibili) in questo processo: niente riletture degli stessi file. */
const missing = new Set<string>()

const TEXTURE = /^([A-Za-z0-9_]{1,64})\/((?:[A-Za-z0-9_.-]{1,128}\/){0,16}[A-Za-z0-9_.-]{1,128})$/

export function parseTexture(texture: string): { mod: string; path: string } | null {
  const match = TEXTURE.exec(texture)
  if (!match || match[1] === 'Terraria' || match[2].split('/').some((p) => p === '..' || p === '.')) return null
  return { mod: match[1], path: match[2] }
}

const textureLists = new Map<string, { mtimeMs: number; names: string[] }>()

/**
 * Texture di un blocco o di un muro di una mod cercata dal nome: il file <Nome>.rawimg, preferendo quello sotto
 * Tiles/ (o Walls/). È la texture predefinita di tModLoader (cartella della classe); una mod che ne usa un'altra
 * resta senza sprite.
 */
async function findTexture(server: ServerDefinition, mod: string, name: string, kind: SpriteKind): Promise<{ mod: string; path: string } | null> {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(mod) || !/^[A-Za-z0-9_]{1,128}$/.test(name)) return null
  const installed = (await listMods(server)).mods.find((m) => m.name === mod)
  if (!installed) return null
  const file = join(modsDir(server), installed.file)
  const info = await stat(file).catch(() => null)
  if (!info) return null
  let list = textureLists.get(file)
  if (list?.mtimeMs !== info.mtimeMs) {
    const names: string[] = []
    await readModEntries(file, (p) => {
      if (p.endsWith('.rawimg')) names.push(p)
      return false
    }).catch(() => undefined)
    list = { mtimeMs: info.mtimeMs, names }
    textureLists.set(file, list)
  }
  const matches = list.names.filter((p) => p === `${name}.rawimg` || p.endsWith(`/${name}.rawimg`))
  const best = matches.find((p) => p.startsWith(kind === 'tiles' ? 'Tiles/' : 'Walls/')) ?? matches[0]
  return best ? parseTexture(`${mod}/${best.slice(0, -'.rawimg'.length)}`) : null
}

/** rawimg di tModLoader: int32 versione (1), larghezza, altezza, poi i pixel RGBA. */
export function rawimgToPng(data: Buffer): Buffer | null {
  if (data.length < 12 || data.readInt32LE(0) !== 1) return null
  const width = data.readInt32LE(4)
  const height = data.readInt32LE(8)
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192 || data.length < 12 + width * height * 4) return null
  return encodePngRgba(data.subarray(12, 12 + width * height * 4), width, height)
}


/**
 * PNG dello sprite del tipo indicato: di Terraria (se le texture del gioco ci sono) o dalla texture della sua mod
 * (null: mod non installata, texture non trovata). `typesPath`: il types.json di LiveMap del server.
 */
export async function spritePng(server: ServerDefinition, typesPath: string, kind: SpriteKind, type: number): Promise<string | null> {
  // Chiome e rami degli alberi: texture di Terraria a parte, per stile (foresta, giungla, neve…)
  if (kind === 'treetops') return vanillaSpritePng(`Tree_Tops_${type}`)
  if (kind === 'treebranches') return vanillaSpritePng(`Tree_Branches_${type}`)
  if (kind === 'liquids') return vanillaSpritePng(`Liquid_${type}`)
  const entry = await readTileTypes(typesPath)
  if (!entry) return null
  const vanilla = kind === 'tiles' ? entry.types.vanillaTiles : entry.types.vanillaWalls
  if (type < vanilla) return vanillaSpritePng(`${kind === 'tiles' ? 'Tiles' : 'Wall'}_${type}`)
  const mod = (kind === 'tiles' ? entry.types.modTiles : entry.types.modWalls)[String(type)]
  if (!mod) return null
  // Una mod può usare una texture di Terraria ("Terraria/Images/Tiles_1")
  const fromTerraria = /^Terraria\/Images\/((?:Tiles|Wall)_\d{1,5})$/.exec(mod.texture)
  if (fromTerraria) return vanillaSpritePng(fromTerraria[1])
  // Dal file del mondo si sa solo mod e nome: la texture si cerca nel .tmod (di solito Tiles/…/<Nome>)
  const texture = mod.texture ? parseTexture(mod.texture) : await findTexture(server, mod.mod, mod.name, kind)
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

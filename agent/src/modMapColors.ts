import { randomBytes } from 'node:crypto'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { rawimgAverageColor, readModEntries } from './tmod.js'
import type { ModBlockEntry } from './twld.js'

/**
 * Colori della mappa per i blocchi e i muri delle mod. Nel gioco li decide il codice della mod
 * (AddMapEntry), che non si può leggere: si usa il colore medio della texture del blocco, dentro il .tmod
 * (di solito è quello che le mod scelgono). Se la texture non si trova (mod rimossa, texture con un altro
 * nome), un colore tenue ricavato dal nome, sempre lo stesso.
 *
 * In cache per mod (finché il suo .tmod non cambia): <cartella della mappa>/mod-colors.json.
 */

type Cache = { mods: Record<string, { key: string; colors: Record<string, number | null> }> }

const keyOf = (entry: ModBlockEntry, wall: boolean) => `${wall ? 'w' : 't'}:${entry.name}`

/** Colore stabile dal nome: tinta qualsiasi, saturazione e luminosità moderate. */
export function fallbackColor(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  const h = ((hash >>> 0) % 360) / 60
  const s = 0.35
  const l = 0.45
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs((h % 2) - 1))
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x]
  const m = l - c / 2
  return (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255)
}

export async function modBlockColors(
  tiles: ModBlockEntry[],
  walls: ModBlockEntry[],
  modsDir: string | null,
  cachePath: string,
): Promise<{ colorOf: (entry: ModBlockEntry, wall: boolean) => number; fromTextures: number; total: number }> {
  let cache: Cache = { mods: {} }
  try {
    cache = JSON.parse(await readFile(cachePath, 'utf8')) as Cache
  } catch {
    // prima volta
  }

  const byMod = new Map<string, { entry: ModBlockEntry; wall: boolean }[]>()
  for (const [list, wall] of [
    [tiles, false],
    [walls, true],
  ] as const) {
    for (const entry of list) byMod.set(entry.mod, [...(byMod.get(entry.mod) ?? []), { entry, wall }])
  }

  let changed = false
  for (const [mod, wanted] of byMod) {
    const path = modsDir && /^[A-Za-z0-9_]+$/.test(mod) ? join(modsDir, `${mod}.tmod`) : null
    const info = path ? await stat(path).catch(() => null) : null
    const key = info ? `${info.size}:${Math.round(info.mtimeMs)}` : 'missing'
    const cached = cache.mods[mod]
    if (cached?.key === key && wanted.every(({ entry, wall }) => keyOf(entry, wall) in cached.colors)) continue

    const colors: Record<string, number | null> = {}
    if (path && info) {
      // Texture con lo stesso nome del blocco: Tiles/…/<Nome>.rawimg (Walls/ per i muri), o ovunque nella mod
      const names = new Set(wanted.map(({ entry }) => entry.name))
      const textures = await readModEntries(path, (p) => /\.(rawimg|png)$/.test(p) && names.has(p.slice(p.lastIndexOf('/') + 1).replace(/\.(rawimg|png)$/, '')))
      for (const { entry, wall } of wanted) {
        const candidates = [...textures.keys()].filter((p) => p.slice(p.lastIndexOf('/') + 1).replace(/\.(rawimg|png)$/, '') === entry.name)
        const preferred = candidates.find((p) => p.startsWith(wall ? 'Walls/' : 'Tiles/') || p.includes(wall ? '/Walls/' : '/Tiles/')) ?? candidates[0]
        colors[keyOf(entry, wall)] = preferred ? rawimgAverageColor(textures.get(preferred)!) : null
      }
    } else {
      for (const { entry, wall } of wanted) colors[keyOf(entry, wall)] = null
    }
    cache.mods[mod] = { key, colors }
    changed = true
  }

  if (changed) {
    const tmp = `${cachePath}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, JSON.stringify(cache))
    await rename(tmp, cachePath)
  }

  let fromTextures = 0
  for (const [list, wall] of [
    [tiles, false],
    [walls, true],
  ] as const) {
    for (const entry of list) if (cache.mods[entry.mod]?.colors[keyOf(entry, wall)] != null) fromTextures++
  }
  return {
    colorOf: (entry, wall) => cache.mods[entry.mod]?.colors[keyOf(entry, wall)] ?? fallbackColor(`${entry.mod}/${entry.name}`),
    fromTextures,
    total: tiles.length + walls.length,
  }
}

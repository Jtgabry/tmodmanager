import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import type { ModBlocks } from './twld.js'

/**
 * Dati grezzi delle tile ricavati dal file del mondo, per gli sprite della mappa senza LiveMap: stesso formato di
 * LiveMap (addons/Shared/TileData.cs), un file per riquadro (tiles/{cx}_{cy}.bin, gzip) e types.json.
 *
 * Il .wld (e il .twld di tModLoader) si leggono colonna per colonna: i dati si raccolgono una striscia di riquadri
 * alla volta (200 colonne), così in memoria non c'è mai tutto il mondo. Differenze da LiveMap: i frame ci sono solo
 * per mobili e oggetti di più tile (gli altri li calcola il gioco al caricamento: -1, li sceglie il pannello), quelli
 * dei muri mai (0xFF); i blocchi delle mod hanno tipi numerati qui (dopo quelli di Terraria) e la texture si cerca
 * dal nome (vedi mapSprites.ts).
 */

export const TILE_FORMAT = 3
const SIZE = 14
const NO_TILE = 0xffff

export type WorldTileTypes = {
  format: number
  vanillaTiles: number
  vanillaWalls: number
  frameImportant: boolean[]
  solid: boolean[]
  modTiles: Record<string, { mod: string; name: string; texture: string }>
  modWalls: Record<string, { mod: string; name: string; texture: string }>
}

/** Lettura in parallelo dei dati delle mod del .twld (stesso ordine del .wld: colonna per colonna). */
class ModStream {
  private p = 0
  /** Dati finiti prima del previsto: da lì in poi niente blocchi delle mod (la mappa a pixel lo segnala già). */
  broken = false
  constructor(
    private readonly data: Buffer,
    /** valore del .twld → tipo nei dati delle tile, e se ha i frame salvati */
    private readonly ids: Map<number, { id: number; framed: boolean }>,
    private readonly walls: boolean,
  ) {}

  /** Prossima tile: tipo della mod (0 = nessuno), vernice e frame. */
  next(): { id: number; paint: number; frameX: number; frameY: number } | null {
    const d = this.data
    if (this.broken) return null
    if (this.p + 2 > d.length) {
      this.broken = true
      return null
    }
    const value = d[this.p] | (d[this.p + 1] << 8)
    this.p += 2
    if (!value) return null
    const paint = d[this.p++] ?? 0
    const entry = this.ids.get(value)
    let frameX = -1
    let frameY = -1
    if (!this.walls && entry?.framed) {
      if (this.p + 4 > d.length) {
        this.broken = true
        return null
      }
      frameX = d.readInt16LE(this.p)
      frameY = d.readInt16LE(this.p + 2)
      this.p += 4
    }
    return entry ? { id: entry.id, paint, frameX, frameY } : null
  }
}

export class WorldTileSink {
  readonly types: WorldTileTypes
  /** Riquadri finiti: indice (cy * cols + cx) → dati compressi e impronta di quelli non compressi. */
  readonly chunks = new Map<number, { gzip: Buffer; hash: string }>()
  private readonly cols: number
  private strip: Buffer
  private stripX = 0
  private readonly modTiles: ModStream | null
  private readonly modWalls: ModStream | null

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly chunkWidth: number,
    private readonly chunkHeight: number,
    /** Dal .wld: tipi di Terraria con i frame salvati. */
    frameImportant: boolean[],
    /** Quanti tipi di blocco e muro ha Terraria (le tabelle dei colori): i tipi delle mod vengono dopo. */
    vanilla: { tiles: number; walls: number },
    mods: ModBlocks | null,
  ) {
    this.cols = Math.ceil(width / chunkWidth)
    this.strip = Buffer.alloc(chunkWidth * height * SIZE)
    const vanillaTiles = Math.max(vanilla.tiles, frameImportant.length)
    const important = Array.from({ length: vanillaTiles }, (_, i) => frameImportant[i] ?? false)
    this.types = {
      format: TILE_FORMAT,
      vanillaTiles,
      vanillaWalls: vanilla.walls,
      frameImportant: important,
      // Senza il gioco non si sa quali blocchi sono pieni: lo sono quasi tutti quelli senza frame salvati
      solid: important.map((f) => !f),
      modTiles: {},
      modWalls: {},
    }
    const tileIds = new Map<number, { id: number; framed: boolean }>()
    const wallIds = new Map<number, { id: number; framed: boolean }>()
    for (const [i, e] of (mods?.tiles ?? []).entries()) {
      const id = vanillaTiles + i
      tileIds.set(e.value, { id, framed: e.framed })
      this.types.frameImportant[id] = e.framed
      this.types.solid[id] = !e.framed
      this.types.modTiles[String(id)] = { mod: e.mod, name: e.name, texture: '' }
    }
    for (const [i, e] of (mods?.walls ?? []).entries()) {
      const id = vanilla.walls + i
      wallIds.set(e.value, { id, framed: false })
      this.types.modWalls[String(id)] = { mod: e.mod, name: e.name, texture: '' }
    }
    this.modTiles = mods ? new ModStream(mods.tileData, tileIds, false) : null
    this.modWalls = mods ? new ModStream(mods.wallData, wallIds, true) : null
  }

  /**
   * Una tile, nell'ordine del .wld (colonna per colonna, dall'alto in basso; anche quelle ripetute).
   * `type` -1 = nessun blocco; frame -1 = da calcolare; `shape` 0 pieno, 1 mezzo blocco, 2–5 pendenze;
   * `liquid` -1 = niente, 0 acqua, 1 lava, 2 miele, 3 shimmer, con la sua quantità (0–255).
   */
  put(x: number, y: number, type: number, frameX: number, frameY: number, wall: number, shape: number, actuated: boolean, liquid: number, amount: number, paint: number) {
    const mod = this.modTiles?.next()
    const modWall = this.modWalls?.next()
    if (mod) {
      type = mod.id
      frameX = mod.frameX
      frameY = mod.frameY
      paint = mod.paint
    }
    if (modWall) wall = modWall.id
    const o = ((y * this.chunkWidth) + (x - this.stripX)) * SIZE
    const s = this.strip
    s.writeUInt16LE(type < 0 ? NO_TILE : type, o)
    s.writeInt16LE(frameX, o + 2)
    s.writeInt16LE(frameY, o + 4)
    s.writeUInt16LE(wall, o + 6)
    const wet = liquid >= 0 && amount > 0
    s[o + 8] = (shape & 0x07) | (actuated ? 0x08 : 0) | (wet ? 0x10 : 0)
    s[o + 9] = paint
    s[o + 10] = 0xff
    s[o + 11] = 0xff
    s[o + 12] = wet ? liquid : 0
    s[o + 13] = wet ? amount : 0
    if (y === this.height - 1 && (x - this.stripX === this.chunkWidth - 1 || x === this.width - 1)) this.flush()
  }

  /** Fine di una striscia di colonne: i suoi riquadri, riga per riga, compressi. */
  private flush() {
    const cx = this.stripX / this.chunkWidth
    const w = Math.min(this.chunkWidth, this.width - this.stripX)
    for (let cy = 0; cy * this.chunkHeight < this.height; cy++) {
      const h = Math.min(this.chunkHeight, this.height - cy * this.chunkHeight)
      const raw = Buffer.alloc(10 + w * h * SIZE)
      raw.write('TMMT', 0, 'latin1')
      raw[4] = TILE_FORMAT
      raw[5] = SIZE
      raw.writeUInt16LE(w, 6)
      raw.writeUInt16LE(h, 8)
      for (let y = 0; y < h; y++) {
        const from = ((cy * this.chunkHeight + y) * this.chunkWidth) * SIZE
        this.strip.copy(raw, 10 + y * w * SIZE, from, from + w * SIZE)
      }
      this.chunks.set(cy * this.cols + cx, { gzip: gzipSync(raw, { level: 6 }), hash: createHash('sha256').update(raw).digest('hex').slice(0, 16) })
    }
    this.stripX += this.chunkWidth
    this.strip.fill(0)
  }
}

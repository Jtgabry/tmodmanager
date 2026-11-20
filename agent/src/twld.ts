import { gunzipSync } from 'node:zlib'
import { mapPaint } from './paint.js'
import { WorldFileError } from './worldFile.js'

/**
 * File .twld di tModLoader: accanto al .wld, contiene quello che il formato vanilla non sa salvare, tra cui i
 * blocchi e i muri delle mod (nel .wld al loro posto non c'è niente).
 *
 * È un TagCompound di tModLoader (TagIO) compresso con gzip: tag con nome, numeri big-endian, stringhe con
 * lunghezza int16. Tipi: 1 byte · 2 short · 3 int · 4 long · 5 float · 6 double · 7 byte[] · 8 string ·
 * 9 list (tipo, int32 n, valori) · 10 compound (tag con nome fino a 0) · 11 int[].
 *
 * tiles: tileMap/wallMap = elenco { value, mod, name, framed } (value = id usato nei dati);
 * tileData/wallData = una voce per tile, colonna per colonna dall'alto in basso: uint16 (little-endian) id,
 * 0 = nessun blocco della mod; se ≠ 0 seguono 1 byte di vernice e, per i blocchi "framed", 4 byte di frame.
 */

type Tag = number | bigint | string | Buffer | Tag[] | number[] | { [key: string]: Tag }

class TagReader {
  pos = 0
  constructor(private readonly buf: Buffer) {}

  private need(n: number) {
    if (this.pos + n > this.buf.length) throw new WorldFileError('Truncated .twld file')
  }
  private string() {
    this.need(2)
    const length = this.buf.readInt16BE(this.pos)
    this.pos += 2
    if (length < 0) throw new WorldFileError('Invalid string in the .twld')
    this.need(length)
    const s = this.buf.toString('utf8', this.pos, this.pos + length)
    this.pos += length
    return s
  }

  payload(type: number): Tag {
    const b = this.buf
    switch (type) {
      case 1:
        this.need(1)
        return b.readInt8(this.pos++)
      case 2:
        this.need(2)
        this.pos += 2
        return b.readInt16BE(this.pos - 2)
      case 3:
        this.need(4)
        this.pos += 4
        return b.readInt32BE(this.pos - 4)
      case 4:
        this.need(8)
        this.pos += 8
        return b.readBigInt64BE(this.pos - 8)
      case 5:
        this.need(4)
        this.pos += 4
        return b.readFloatBE(this.pos - 4)
      case 6:
        this.need(8)
        this.pos += 8
        return b.readDoubleBE(this.pos - 8)
      case 7: {
        const length = this.payload(3) as number
        if (length < 0) throw new WorldFileError('Invalid data in the .twld')
        this.need(length)
        this.pos += length
        return b.subarray(this.pos - length, this.pos)
      }
      case 8:
        return this.string()
      case 9: {
        this.need(5)
        const elementType = b[this.pos++]
        const count = this.payload(3) as number
        if (elementType === 0 && count > 0) throw new WorldFileError('Invalid list in the .twld')
        const list: Tag[] = []
        for (let i = 0; i < count; i++) list.push(this.payload(elementType))
        return list
      }
      case 10: {
        const compound: { [key: string]: Tag } = {}
        for (;;) {
          this.need(1)
          const tagType = b[this.pos++]
          if (tagType === 0) return compound
          const name = this.string()
          compound[name] = this.payload(tagType)
        }
      }
      case 11: {
        const count = this.payload(3) as number
        const ints: number[] = []
        for (let i = 0; i < count; i++) ints.push(this.payload(3) as number)
        return ints
      }
      default:
        throw new WorldFileError(`Unknown tag type in the .twld (${type})`)
    }
  }

  root() {
    this.need(1)
    if (this.buf[this.pos++] !== 10) throw new WorldFileError('The .twld does not start with a TagCompound')
    this.string()
    return this.payload(10) as { [key: string]: Tag }
  }
}

export type ModBlockEntry = { value: number; mod: string; name: string; framed: boolean }

export type ModBlocks = { tiles: ModBlockEntry[]; walls: ModBlockEntry[]; tileData: Buffer; wallData: Buffer }

const entries = (list: Tag | undefined): ModBlockEntry[] =>
  Array.isArray(list)
    ? list.flatMap((e) => {
        if (!e || typeof e !== 'object' || Buffer.isBuffer(e) || Array.isArray(e)) return []
        const { value, mod, name, framed } = e as { [key: string]: Tag }
        return typeof value === 'number' && typeof mod === 'string' && typeof name === 'string' ? [{ value, mod, name, framed: framed === 1 }] : []
      })
    : []

/** Blocchi e muri delle mod di un .twld; null se il file non ne ha. */
export function readModBlocks(gzipped: Buffer): ModBlocks | null {
  let data: Buffer
  try {
    data = gunzipSync(gzipped)
  } catch {
    throw new WorldFileError('The .twld is not a valid gzip file')
  }
  const tiles = new TagReader(data).root().tiles
  if (!tiles || typeof tiles !== 'object' || Buffer.isBuffer(tiles) || Array.isArray(tiles)) return null
  const { tileMap, wallMap, tileData, wallData } = tiles as { [key: string]: Tag }
  return {
    tiles: entries(tileMap),
    walls: entries(wallMap),
    tileData: Buffer.isBuffer(tileData) ? tileData : Buffer.alloc(0),
    wallData: Buffer.isBuffer(wallData) ? wallData : Buffer.alloc(0),
  }
}

/** Livello vincente di ogni pixel della mappa (renderWorld): i blocchi delle mod vanno sopra o sotto. */
export const LAYER = { background: 0, wall: 1, liquid: 2, tile: 3 } as const

/**
 * Disegna sopra la mappa del .wld i blocchi e i muri delle mod: un blocco copre tutto, un muro solo lo sfondo.
 * `colorOf` dà il colore di una voce (mod/nome).
 */
export function overlayModBlocks(pixels: Uint32Array, layers: Uint8Array, width: number, height: number, blocks: ModBlocks, colorOf: (entry: ModBlockEntry, wall: boolean) => number) {
  const draw = (data: Buffer, list: ModBlockEntry[], wall: boolean) => {
    const byValue = new Map(list.map((e) => [e.value, e]))
    const color = new Map(list.map((e) => [e.value, colorOf(e, wall)]))
    const total = width * height
    let p = 0
    for (let i = 0; i < total; i++) {
      if (p + 2 > data.length) throw new WorldFileError('Truncated mod data in the .twld')
      const value = data[p] | (data[p + 1] << 8)
      p += 2
      if (!value) continue
      const paint = data[p]
      p += 1
      if (!wall && byValue.get(value)?.framed) p += 4
      // Colonna per colonna: i = x * height + y
      const x = Math.floor(i / height)
      const index = (i - x * height) * width + x
      const base = color.get(value)
      if (base === undefined) continue
      // Verniciato: come la minimappa del gioco
      const c = paint ? mapPaint(base, paint, wall) : base
      if (!wall) {
        pixels[index] = c
        layers[index] = LAYER.tile
      } else if (layers[index] === LAYER.background) {
        pixels[index] = c
        layers[index] = LAYER.wall
      }
    }
  }
  draw(blocks.wallData, blocks.walls, true)
  draw(blocks.tileData, blocks.tiles, false)
}

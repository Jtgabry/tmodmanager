/**
 * Lettura dei file del mondo di Terraria (.wld), per disegnarne la mappa senza il gioco.
 *
 * Formato (Terraria 1.3 e 1.4, anche quelli scritti da tModLoader):
 *   int32 versione · "relogic" + tipo (2 = mondo) · revisione · preferiti
 *   int16 n. sezioni · int32[] posizioni delle sezioni (0 = intestazione, 1 = blocchi, …)
 *   int16 n. tipi di blocco · bit "frame importanti" (questi blocchi salvano anche frameX/frameY)
 * Intestazione: nome, seed, versione del generatore, GUID, id, rettangolo, altezza, larghezza, poi decine di
 * campi che cambiano a ogni versione: spawn e livelli (superficie, roccia) si trovano cercandoli (vedi findLevels).
 * Blocchi: colonna per colonna, dall'alto in basso, con ripetizioni (RLE) per le tile uguali consecutive.
 */

export class WorldFileError extends Error {}

/** Tabelle dei colori della minimappa (addons/tools/MapColors → map-colors.json). */
export type MapColors = {
  format: 1
  terraria: string | null
  colors: number[]
  tileLookup: number[]
  tileOptionCounts: number[]
  wallLookup: number[]
  wallOptionCounts: number[]
  liquidPosition: number
  skyPosition: number
  dirtPosition: number
  rockPosition: number
  hellPosition: number
  maxSkyGradients: number
  maxDirtGradients: number
  maxRockGradients: number
}

export type WorldHeader = {
  version: number
  name: string
  id: number
  width: number
  height: number
  spawnX: number
  spawnY: number
  surface: number
  rock: number
  /** Tipi di blocco che salvano frameX/frameY. */
  frameImportant: boolean[]
  tilesOffset: number
}

/** Versione minima: 1.3.0 (prima il formato dei blocchi era diverso). */
const MIN_VERSION = 147

class Reader {
  constructor(
    readonly buf: Buffer,
    public pos = 0,
  ) {}

  need(n: number) {
    if (this.pos + n > this.buf.length) throw new WorldFileError('File del mondo troncato')
  }
  byte() {
    this.need(1)
    return this.buf[this.pos++]
  }
  int16() {
    this.need(2)
    const v = this.buf.readInt16LE(this.pos)
    this.pos += 2
    return v
  }
  int32() {
    this.need(4)
    const v = this.buf.readInt32LE(this.pos)
    this.pos += 4
    return v
  }
  skip(n: number) {
    this.need(n)
    this.pos += n
  }
  /** Stringa di BinaryWriter (.NET): lunghezza a 7 bit per byte, poi UTF-8. */
  string() {
    let length = 0
    for (let shift = 0; ; shift += 7) {
      const b = this.byte()
      length |= (b & 0x7f) << shift
      if (b < 0x80) break
      if (shift > 28) throw new WorldFileError('Stringa non valida nel file del mondo')
    }
    this.need(length)
    const s = this.buf.toString('utf8', this.pos, this.pos + length)
    this.pos += length
    return s
  }
}

export function readWorldHeader(buf: Buffer): WorldHeader {
  const r = new Reader(buf)
  const version = r.int32()
  if (version < MIN_VERSION || version > 10_000) throw new WorldFileError(`Versione del mondo non supportata (${version})`)
  if (buf.toString('latin1', 4, 11) !== 'relogic' || buf[11] !== 2) throw new WorldFileError('Non è un file del mondo di Terraria')
  r.skip(8 + 4 + 8)

  const sections = r.int16()
  if (sections < 2 || sections > 64) throw new WorldFileError('Sezioni del file del mondo non valide')
  const positions = Array.from({ length: sections }, () => r.int32())

  const types = r.int16()
  const frameImportant: boolean[] = new Array(types).fill(false)
  let bits = 0
  for (let i = 0, mask = 128; i < types; i++) {
    if (mask === 128) {
      bits = r.byte()
      mask = 1
    } else mask <<= 1
    if (bits & mask) frameImportant[i] = true
  }

  r.pos = positions[0]
  const name = r.string()
  if (version >= 179) {
    r.string() // seed
    r.skip(8) // versione del generatore
  }
  if (version >= 181) r.skip(16) // GUID
  const id = r.int32()
  r.skip(16) // rettangolo del mondo in pixel
  const height = r.int32()
  const width = r.int32()
  if (width < 100 || height < 100 || width > 20_000 || height > 10_000) throw new WorldFileError('Dimensioni del mondo non valide')

  const levels = findLevels(buf, r.pos, width, height)
  return { version, name, id, width, height, ...levels, frameImportant, tilesOffset: positions[1] }
}

/**
 * Spawn (int32 x, int32 y) seguito da superficie e strato roccioso (double), cercati nei primi byte dopo le
 * dimensioni: i campi in mezzo cambiano a ogni versione di Terraria, i vincoli su questi quattro valori
 * insieme (spawn nel mondo, superficie sopra la roccia, spawn sopra la roccia) li individuano senza ambiguità.
 */
function findLevels(buf: Buffer, from: number, width: number, height: number) {
  for (let p = from; p < Math.min(from + 1024, buf.length - 24); p++) {
    const spawnX = buf.readInt32LE(p)
    const spawnY = buf.readInt32LE(p + 4)
    if (spawnX <= 40 || spawnX >= width - 40 || spawnY <= 0 || spawnY >= height) continue
    const surface = buf.readDoubleLE(p + 8)
    const rock = buf.readDoubleLE(p + 16)
    if (!(surface > 50 && surface < height * 0.7 && rock > surface && rock < height && spawnY < rock)) continue
    if (!Number.isInteger(surface) || !Number.isInteger(rock)) continue
    return { spawnX, spawnY, surface, rock }
  }
  // Valori tipici, se il formato fosse cambiato troppo
  return { spawnX: Math.floor(width / 2), spawnY: Math.floor(height * 0.2), surface: Math.floor(height * 0.3), rock: Math.floor(height * 0.4) }
}

/** Colore di sfondo per riga: cielo, terra, roccia (con le sfumature del gioco) e inferi. */
function backgroundColors(header: WorldHeader, c: MapColors): Uint32Array {
  const rows = new Uint32Array(header.height)
  const underworld = header.height - 200
  const step = (from: number, to: number, y: number, max: number) => Math.min(max - 1, Math.max(0, Math.floor(((y - from) / Math.max(1, to - from)) * max)))
  for (let y = 0; y < header.height; y++) {
    const index =
      y < header.surface
        ? c.skyPosition + step(0, header.surface, y, c.maxSkyGradients)
        : y < header.rock
          ? c.dirtPosition + step(header.surface, header.rock, y, c.maxDirtGradients)
          : y < underworld
            ? c.rockPosition + step(header.rock, underworld, y, c.maxRockGradients)
            : c.hellPosition
    rows[y] = c.colors[index] ?? 0
  }
  return rows
}

/**
 * Colori di tutte le tile (0xRRGGBB, riga per riga: indice y * larghezza + x), come la minimappa del gioco a
 * piena luce: blocco, altrimenti liquido, altrimenti muro, altrimenti sfondo. Variante dei blocchi: la prima
 * (alcuni blocchi, come gli alberi, nel gioco cambiano colore secondo il bioma). `layers` dice quale di questi
 * ha vinto in ogni pixel (0 sfondo, 1 muro, 2 liquido, 3 blocco): serve per sovrapporre i blocchi delle mod.
 */
/** Chi raccoglie i dati grezzi delle tile, nell'ordine del file (vedi worldTiles.ts). */
export type TileSink = {
  put(x: number, y: number, type: number, frameX: number, frameY: number, wall: number, shape: number, actuated: boolean, liquid: boolean, paint: number): void
}

export function renderWorld(buf: Buffer, header: WorldHeader, c: MapColors, sink?: TileSink): { pixels: Uint32Array; layers: Uint8Array } {
  const { width, height, frameImportant } = header
  const pixels = new Uint32Array(width * height)
  const layers = new Uint8Array(width * height)
  const background = backgroundColors(header, c)
  const tileColor = Int32Array.from(c.tileLookup, (i) => (i > 0 ? c.colors[i] : -1))
  const wallColor = Int32Array.from(c.wallLookup, (i) => (i > 0 ? c.colors[i] : -1))
  const liquidColor = [0, 1, 2, 3].map((i) => c.colors[c.liquidPosition + i] ?? 0)

  const r = new Reader(buf, header.tilesOffset)
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const h1 = r.byte()
      let h2 = 0
      let h3 = 0
      if (h1 & 1) {
        h2 = r.byte()
        if (h2 & 1) {
          h3 = r.byte()
          if (h3 & 1) r.byte() // quarta intestazione (blocchi e muri invisibili, luminosi): non serve
        }
      }

      let tile = -1
      let frameX = -1
      let frameY = -1
      let paint = 0
      if (h1 & 2) {
        tile = h1 & 0x20 ? r.byte() | (r.byte() << 8) : r.byte()
        if (frameImportant[tile]) {
          frameX = r.int16()
          frameY = r.int16()
        }
        if (h3 & 8) paint = r.byte() // vernice
      }
      let wall = 0
      if (h1 & 4) {
        wall = r.byte()
        if (h3 & 0x10) r.byte() // vernice del muro
      }
      const liquidBits = (h1 & 0x18) >> 3
      let liquid = -1
      if (liquidBits) {
        const amount = r.byte()
        if (amount > 0) liquid = h3 & 0x80 ? 3 : liquidBits - 1 // acqua, lava, miele; shimmer
      }
      if (h3 & 0x40) wall |= r.byte() << 8

      let color = -1
      let layer = 0
      const solid = tile >= 0 && tile < tileColor.length ? tileColor[tile] : -1
      if (solid >= 0 && !(h3 & 4)) {
        color = solid // i blocchi disattivati da un attuatore non si vedono
        layer = 3
      } else if (liquid >= 0) {
        color = liquidColor[liquid]
        layer = 2
      } else if (wall > 0 && wall < wallColor.length && wallColor[wall] >= 0) {
        color = wallColor[wall]
        layer = 1
      }

      const repeat = (h1 & 0xc0) >> 6
      let count = repeat === 0 ? 0 : repeat === 1 ? r.byte() : r.int16()
      if (count < 0 || y + count >= height) count = Math.max(0, Math.min(count, height - 1 - y))
      // Forma (h2): 1 mezzo blocco, 2–5 pendenze; attuatore (h3 & 4)
      const shape = (h2 >> 4) & 7
      const actuated = (h3 & 4) !== 0
      // Senza blocco, liquido o muro: lo sfondo, che cambia con la profondità (anche per le tile ripetute)
      pixels[y * width + x] = color >= 0 ? color : background[y]
      layers[y * width + x] = layer
      sink?.put(x, y, tile, frameX, frameY, wall, shape, actuated, liquid >= 0, paint)
      while (count-- > 0) {
        y++
        pixels[y * width + x] = color >= 0 ? color : background[y]
        layers[y * width + x] = layer
        sink?.put(x, y, tile, frameX, frameY, wall, shape, actuated, liquid >= 0, paint)
      }
    }
  }
  return { pixels, layers }
}

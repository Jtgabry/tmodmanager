import type { TileTypes } from '../../lib/types'

/**
 * Vista ravvicinata della mappa con gli sprite di blocchi e muri. LiveMap manda, per ogni riquadro, i dati grezzi
 * delle tile (addons/Shared/TileData.cs): tipo, frame (calcolati dal gioco), muro e suo frame, forma. Qui si
 * disegna quella parte del foglio di sprite sopra la mappa a pixel. Blocchi e muri delle mod sempre; quelli di
 * Terraria se il pannello ha le texture del gioco (`vanilla`), altrimenti restano del loro colore.
 */

/** Offset dei campi di una tile (TileData); la lunghezza dipende dal formato (`stride`). */
const NO_TILE = 0xffff
const ACTUATED = 0x08
const LIQUID = 0x10
const UNKNOWN_FRAME = 0xff
/** Formato → byte per tile (1: senza i frame dei muri). */
const FORMATS: Record<number, number> = { 1: 10, 2: 12 }

export type TileChunk = {
  width: number
  height: number
  /** Byte per tile. */
  stride: number
  data: DataView
  /** Colori della mappa a pixel dello stesso riquadro (0xRRGGBB): riempiono dietro gli sprite e davanti ai muri. */
  pixels: Uint32Array | null
}

/** Decomprime e controlla un file tiles/{cx}_{cy}.bin ("TMMT", formato 1 o 2). */
export async function decodeTileChunk(gzipped: ArrayBuffer): Promise<Omit<TileChunk, 'pixels'> | null> {
  const stream = new Blob([gzipped]).stream().pipeThrough(new DecompressionStream('gzip'))
  const buffer = await new Response(stream).arrayBuffer()
  const view = new DataView(buffer)
  if (buffer.byteLength < 10 || String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)) !== 'TMMT') return null
  const stride = FORMATS[view.getUint8(4)]
  if (!stride || view.getUint8(5) !== stride) return null
  const width = view.getUint16(6, true)
  const height = view.getUint16(8, true)
  if (buffer.byteLength < 10 + width * height * stride) return null
  return { width, height, stride, data: new DataView(buffer, 10) }
}

/** Colori di un'immagine (il riquadro PNG della mappa), letti con un canvas. */
export async function imagePixels(url: string): Promise<Uint32Array | null> {
  const image = new Image()
  image.src = url
  try {
    await image.decode()
  } catch {
    return null
  }
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(image, 0, 0)
  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  const out = new Uint32Array(canvas.width * canvas.height)
  for (let i = 0; i < out.length; i++) out[i] = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2]
  return out
}

export const tileType = (chunk: TileChunk, i: number) => chunk.data.getUint16(i * chunk.stride, true)
const flagsOf = (chunk: TileChunk, i: number) => chunk.data.getUint8(i * chunk.stride + 8)
const wallOf = (chunk: TileChunk, i: number) => chunk.data.getUint16(i * chunk.stride + 6, true)

/**
 * Parte del foglio di sprite di un blocco pieno, in unità da 18 pixel (16 + 2 di bordo), secondo i quattro
 * vicini dello stesso tipo: è la tabella di WorldGen.TileFrame di Terraria (senza le fusioni tra blocchi diversi).
 * Serve solo se il frame non è arrivato dal gioco. `variant` (0–2) sceglie tra le tre versioni di ogni pezzo.
 */
export function blockFrame(up: boolean, down: boolean, left: boolean, right: boolean, variant: number): [number, number] {
  const v = variant
  if (up && down && left && right) return [1 + v, 1]
  if (!up && down && left && right) return [1 + v, 0]
  if (up && !down && left && right) return [1 + v, 2]
  if (up && down && !left && right) return [0, v]
  if (up && down && left && !right) return [4, v]
  if (!up && down && !left && right) return [2 * v, 3]
  if (!up && down && left && !right) return [1 + 2 * v, 3]
  if (up && !down && !left && right) return [2 * v, 4]
  if (up && !down && left && !right) return [1 + 2 * v, 4]
  if (up && down && !left && !right) return [5, v]
  if (!up && !down && left && right) return [6 + v, 4]
  if (!up && down && !left && !right) return [6 + v, 0]
  if (up && !down && !left && !right) return [6 + v, 3]
  if (!up && !down && !left && right) return [9, v]
  if (!up && !down && left && !right) return [12, v]
  return [9 + v, 3]
}

/** Variante stabile per posizione (il gioco la sceglie a caso e la tiene: qui serve solo che non cambi). */
const variantAt = (x: number, y: number) => (((x * 73856093) ^ (y * 19349663)) >>> 0) % 3

export type SpriteKind = 'tiles' | 'walls'

export type SpriteSource = {
  types: TileTypes
  /** Ci sono anche gli sprite di Terraria. */
  vanilla: boolean
  /** Foglio di sprite del tipo, se è caricato (null: non ancora, o non c'è). */
  sheet: (kind: SpriteKind, type: number) => HTMLImageElement | null
  /** Riquadro (cx, cy) già caricato, oppure null. */
  chunk: (cx: number, cy: number) => TileChunk | null
}

const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`

/**
 * Disegna gli sprite di muri e blocchi visibili, come il gioco: prima i muri (32×32, centrati sulla tile e
 * debordanti di 8 pixel per lato), poi i blocchi, che li coprono. `view` è la vista della mappa (tile in alto a
 * sinistra e pixel per tile), `ctx` un canvas grande quanto la mappa sullo schermo.
 */
export function drawSprites(
  ctx: CanvasRenderingContext2D,
  view: { x: number; y: number; zoom: number },
  screen: { w: number; h: number },
  grid: { chunkWidth: number; chunkHeight: number; worldWidth: number; worldHeight: number },
  source: SpriteSource,
) {
  const { types, vanilla } = source
  const { chunkWidth: cw, chunkHeight: ch } = grid
  /** Il tipo ha (o può avere) uno sprite. */
  const tileSprite = (type: number) => type !== NO_TILE && (vanilla || type >= types.vanillaTiles)
  const wallSprite = (wall: number) => wall !== 0 && (vanilla || wall >= types.vanillaWalls)
  const z = view.zoom
  // Una tile in più per lato: i muri debordano sulle vicine
  const x0 = Math.max(0, Math.floor(view.x) - 1)
  const y0 = Math.max(0, Math.floor(view.y) - 1)
  const x1 = Math.min(grid.worldWidth - 1, Math.ceil(view.x + screen.w / z) + 1)
  const y1 = Math.min(grid.worldHeight - 1, Math.ceil(view.y + screen.h / z) + 1)
  const cols = x1 - x0 + 1
  ctx.imageSmoothingEnabled = false

  /** Tile (x, y) del mondo: riquadro e indice, se il riquadro è caricato. */
  const at = (x: number, y: number): [TileChunk, number] | null => {
    const chunk = source.chunk(Math.floor(x / cw), Math.floor(y / ch))
    return chunk ? [chunk, (y % ch) * chunk.width + (x % cw)] : null
  }
  /** Rettangolo della tile sullo schermo, in pixel interi (tile vicine senza fessure). */
  const rect = (x: number, y: number) => {
    const sx = Math.round((x - view.x) * z)
    const sy = Math.round((y - view.y) * z)
    return { sx, sy, w: Math.round((x + 1 - view.x) * z) - sx, h: Math.round((y + 1 - view.y) * z) - sy }
  }
  /** C'è un blocco che si vede (non disattivato da un attuatore). */
  const blockAt = (chunk: TileChunk, i: number) => tileType(chunk, i) !== NO_TILE && (flagsOf(chunk, i) & ACTUATED) === 0

  // 1. Muri: dove non c'è un blocco pieno né un liquido davanti (lì il gioco non li mostra)
  const wallDrawn = new Uint8Array(cols * (y1 - y0 + 1))
  let walls = 0
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = at(x, y)
      if (!t) continue
      const [chunk, i] = t
      const wall = wallOf(chunk, i)
      if (!wallSprite(wall)) continue
      const flags = flagsOf(chunk, i)
      if (flags & LIQUID) continue
      if (blockAt(chunk, i)) {
        const type = tileType(chunk, i)
        // Davanti: un blocco pieno, o uno senza sprite (resterebbe solo il colore del muro)
        if (types.solid[type] || !tileSprite(type)) continue
      }
      const sheet = source.sheet('walls', wall)
      if (!sheet) continue
      let col = chunk.stride >= 12 ? chunk.data.getUint8(i * chunk.stride + 10) : UNKNOWN_FRAME
      let row = chunk.stride >= 12 ? chunk.data.getUint8(i * chunk.stride + 11) : UNKNOWN_FRAME
      if (col === UNKNOWN_FRAME || row === UNKNOWN_FRAME) [col, row] = [1 + variantAt(x, y), 1] // pezzo interno, se il gioco non l'ha calcolato
      if (col * 36 + 32 > sheet.naturalWidth || row * 36 + 32 > sheet.naturalHeight) continue
      const { sx, sy, w, h } = rect(x, y)
      ctx.drawImage(sheet, col * 36, row * 36, 32, 32, sx - w / 2, sy - h / 2, w * 2, h * 2)
      wallDrawn[(y - y0) * cols + (x - x0)] = 1
      walls++
    }
  }

  // 2. Davanti ai muri: le tile vicine con un blocco o un liquido tornano del loro colore (i muri debordano)
  if (walls > 0) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const k = (y - y0) * cols + (x - x0)
        if (wallDrawn[k]) continue
        let near = false
        for (let dy = -1; dy <= 1 && !near; dy++) {
          for (let dx = -1; dx <= 1 && !near; dx++) {
            const nx = x + dx - x0
            const ny = y + dy - y0
            if (nx >= 0 && ny >= 0 && nx < cols && ny <= y1 - y0 && wallDrawn[ny * cols + nx]) near = true
          }
        }
        if (!near) continue
        const t = at(x, y)
        if (!t || !t[0].pixels) continue
        const [chunk, i] = t
        if (!blockAt(chunk, i) && !(flagsOf(chunk, i) & LIQUID)) continue
        const { sx, sy, w, h } = rect(x, y)
        ctx.fillStyle = hex(chunk.pixels![i])
        ctx.fillRect(sx, sy, w, h)
      }
    }
  }

  /** Stesso tipo nella tile vicina (fuori dal mondo o in un riquadro non caricato: sì, così non spuntano bordi). */
  const same = (x: number, y: number, type: number) => {
    if (x < 0 || y < 0 || x >= grid.worldWidth || y >= grid.worldHeight) return true
    const t = at(x, y)
    if (!t) return true
    return tileType(t[0], t[1]) === type && (flagsOf(t[0], t[1]) & ACTUATED) === 0
  }
  /** Colore della mappa a pixel della prima tile vicina di un altro tipo: riempie dietro gli sprite trasparenti. */
  const behind = (x: number, y: number, type: number): number | null => {
    for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]] as const) {
      const t = at(x + dx, y + dy)
      if (!t || tileType(t[0], t[1]) === type || !t[0].pixels) continue
      return t[0].pixels[t[1]]
    }
    return null
  }

  // 3. Blocchi
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = at(x, y)
      if (!t) continue
      const [chunk, i] = t
      const type = tileType(chunk, i)
      if (!tileSprite(type)) continue
      const flags = flagsOf(chunk, i)
      if (flags & ACTUATED) continue // disattivato da un attuatore: nella mappa non c'è
      const sheet = source.sheet('tiles', type)
      if (!sheet) continue

      let fx = chunk.data.getInt16(i * chunk.stride + 2, true)
      let fy = chunk.data.getInt16(i * chunk.stride + 4, true)
      // I frame li calcola il gioco (LiveMap, con il codice delle mod: anche i loro schemi). Se mancano ancora,
      // la tabella dei blocchi di Terraria, che va bene per le mod che non ne hanno uno proprio
      if (fx < 0 || fy < 0) {
        if (types.frameImportant[type]) continue
        const [col, row] = blockFrame(same(x, y - 1, type), same(x, y + 1, type), same(x - 1, y, type), same(x + 1, y, type), variantAt(x, y))
        fx = col * 18
        fy = row * 18
      }
      if (fx + 16 > sheet.naturalWidth || fy + 16 > sheet.naturalHeight) continue

      const { sx, sy, w, h } = rect(x, y)
      // Dietro uno sprite trasparente: il muro, se l'abbiamo disegnato, altrimenti il colore di una tile vicina
      const fill = wallDrawn[(y - y0) * cols + (x - x0)] ? null : behind(x, y, type)
      if (fill !== null) {
        ctx.fillStyle = hex(fill)
        ctx.fillRect(sx, sy, w, h)
      }
      // Mezzo blocco: la metà alta dello sprite, nella metà bassa della tile (le pendenze per ora restano piene)
      if ((flags & 0x07) === 1) ctx.drawImage(sheet, fx, fy, 16, 8, sx, sy + Math.round(h / 2), w, h - Math.round(h / 2))
      else ctx.drawImage(sheet, fx, fy, 16, 16, sx, sy, w, h)
    }
  }
}

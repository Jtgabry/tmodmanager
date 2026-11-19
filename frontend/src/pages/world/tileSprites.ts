import type { TileTypes } from '../../lib/types'

/**
 * Vista ravvicinata della mappa con gli sprite dei blocchi. LiveMap manda, per ogni riquadro, i dati grezzi delle
 * tile (addons/Shared/TileData.cs): tipo, frame (calcolati dal gioco), muro, forma. Qui si disegna quella parte
 * del foglio di sprite sopra la mappa a pixel. Per ora solo i blocchi delle mod (gli sprite di Terraria
 * non sono sul server): gli altri restano del loro colore.
 */

/** Byte per tile e offset dei campi (TileData). */
const SIZE = 10
const NO_TILE = 0xffff
const ACTUATED = 0x08

export type TileChunk = {
  width: number
  height: number
  data: DataView
  /** Colori della mappa a pixel dello stesso riquadro (0xRRGGBB), per riempire i bordi trasparenti degli sprite. */
  pixels: Uint32Array | null
}

/** Decomprime e controlla un file tiles/{cx}_{cy}.bin ("TMMT", formato 1). */
export async function decodeTileChunk(gzipped: ArrayBuffer): Promise<Omit<TileChunk, 'pixels'> | null> {
  const stream = new Blob([gzipped]).stream().pipeThrough(new DecompressionStream('gzip'))
  const buffer = await new Response(stream).arrayBuffer()
  const view = new DataView(buffer)
  if (buffer.byteLength < 10 || String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)) !== 'TMMT') return null
  if (view.getUint8(4) !== 1 || view.getUint8(5) !== SIZE) return null
  const width = view.getUint16(6, true)
  const height = view.getUint16(8, true)
  if (buffer.byteLength < 10 + width * height * SIZE) return null
  return { width, height, data: new DataView(buffer, 10) }
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

export const tileType = (chunk: TileChunk, i: number) => chunk.data.getUint16(i * SIZE, true)

/**
 * Parte del foglio di sprite di un blocco pieno, in unità da 18 pixel (16 + 2 di bordo), secondo i quattro
 * vicini dello stesso tipo: è la tabella di WorldGen.TileFrame di Terraria (senza le fusioni tra blocchi diversi).
 * `variant` (0–2) sceglie tra le tre versioni di ogni pezzo, come fa il gioco a caso.
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

export type SpriteSource = {
  types: TileTypes
  /** Foglio di sprite del tipo, se è caricato (null: non ancora, o non c'è). */
  sheet: (type: number) => HTMLImageElement | null
  /** Riquadro (cx, cy) già caricato, oppure null. */
  chunk: (cx: number, cy: number) => TileChunk | null
}

/**
 * Disegna gli sprite dei blocchi delle mod visibili. `view` è la vista della mappa (tile in alto a sinistra e pixel
 * per tile), `ctx` un canvas grande quanto la mappa sullo schermo.
 */
export function drawSprites(
  ctx: CanvasRenderingContext2D,
  view: { x: number; y: number; zoom: number },
  screen: { w: number; h: number },
  grid: { chunkWidth: number; chunkHeight: number; worldWidth: number; worldHeight: number },
  source: SpriteSource,
) {
  const { types } = source
  const { chunkWidth: cw, chunkHeight: ch } = grid
  const z = view.zoom
  const x0 = Math.max(0, Math.floor(view.x))
  const y0 = Math.max(0, Math.floor(view.y))
  const x1 = Math.min(grid.worldWidth - 1, Math.ceil(view.x + screen.w / z))
  const y1 = Math.min(grid.worldHeight - 1, Math.ceil(view.y + screen.h / z))
  ctx.imageSmoothingEnabled = false

  /** Tile (x, y) del mondo: riquadro e indice, se il riquadro è caricato. */
  const at = (x: number, y: number): [TileChunk, number] | null => {
    const chunk = source.chunk(Math.floor(x / cw), Math.floor(y / ch))
    return chunk ? [chunk, (y % ch) * chunk.width + (x % cw)] : null
  }
  /** Stesso tipo nella tile vicina (fuori dal mondo o in un riquadro non caricato: sì, così non spuntano bordi). */
  const same = (x: number, y: number, type: number) => {
    if (x < 0 || y < 0 || x >= grid.worldWidth || y >= grid.worldHeight) return true
    const t = at(x, y)
    if (!t) return true
    const [chunk, i] = t
    return tileType(chunk, i) === type && (chunk.data.getUint8(i * SIZE + 8) & ACTUATED) === 0
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

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = at(x, y)
      if (!t) continue
      const [chunk, i] = t
      const type = tileType(chunk, i)
      if (type === NO_TILE || type < types.vanillaTiles) continue
      const sheet = source.sheet(type)
      if (!sheet) continue
      const flags = chunk.data.getUint8(i * SIZE + 8)
      if (flags & ACTUATED) continue // disattivato da un attuatore: nella mappa non c'è

      let fx = chunk.data.getInt16(i * SIZE + 2, true)
      let fy = chunk.data.getInt16(i * SIZE + 4, true)
      // I frame li calcola il gioco (LiveMap, con il codice delle mod: anche i loro schemi). Se mancano ancora,
      // la tabella dei blocchi di Terraria, che va bene per le mod che non ne hanno uno proprio
      if (fx < 0 || fy < 0) {
        if (types.frameImportant[type]) continue
        const [col, row] = blockFrame(same(x, y - 1, type), same(x, y + 1, type), same(x - 1, y, type), same(x + 1, y, type), variantAt(x, y))
        fx = col * 18
        fy = row * 18
      }
      if (fx + 16 > sheet.naturalWidth || fy + 16 > sheet.naturalHeight) continue

      // Pixel interi: tile vicine senza fessure tra l'una e l'altra
      const sx = Math.round((x - view.x) * z)
      const sy = Math.round((y - view.y) * z)
      const w = Math.round((x + 1 - view.x) * z) - sx
      const h = Math.round((y + 1 - view.y) * z) - sy
      const fill = behind(x, y, type)
      if (fill !== null) {
        ctx.fillStyle = `#${fill.toString(16).padStart(6, '0')}`
        ctx.fillRect(sx, sy, w, h)
      }
      // Mezzo blocco: la metà alta dello sprite, nella metà bassa della tile (le pendenze per ora restano piene)
      if ((flags & 0x07) === 1) ctx.drawImage(sheet, fx, fy, 16, 8, sx, sy + Math.round(h / 2), w, h - Math.round(h / 2))
      else ctx.drawImage(sheet, fx, fy, 16, 16, sx, sy, w, h)
    }
  }
}

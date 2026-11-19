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
/** Formato → byte per tile (1: senza i frame dei muri; 2: senza tipo e quantità dei liquidi). */
const FORMATS: Record<number, number> = { 1: 10, 2: 12, 3: 14 }

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

export type SpriteKind = 'tiles' | 'walls' | 'treetops' | 'treebranches' | 'liquids'

/** Liquidi (texture Liquid_N): lava, miele e shimmer hanno la loro; l'acqua ha uno stile per bioma. */
const LIQUID_STYLE = [-1, 1, 11, 14]
/** Trasparenza dei liquidi sopra i muri, circa come nel gioco: acqua, lava, miele, shimmer. */
const LIQUID_ALPHA = [0.55, 0.95, 0.85, 0.7]
/** Blocchi tipici dei biomi → stile dell'acqua (Liquid_N); il deserto sotto la superficie ha uno stile suo. */
const WATER_BIOME: Record<number, number> = {
  23: 2, 25: 2, 112: 2, 163: 2, 398: 2, 400: 2, // corruzione
  60: 3, 61: 3, 62: 3, 74: 3, // giungla
  109: 4, 116: 4, 117: 4, 164: 4, 402: 4, 403: 4, // consacrato
  147: 5, 148: 5, 161: 5, 162: 5, 200: 5, // neve e ghiaccio
  53: 6, 396: 6, 397: 6, // deserto
  199: 10, 203: 10, 234: 10, 399: 10, 401: 10, // cremisi
}

/** Alberi di Terraria (tipo 5): cima e rami sono tile del tronco con questi frame, disegnate con texture a parte. */
const TREE = 5
/** Stile di chioma e rami secondo il blocco sotto il tronco (Tree_Tops_N, Tree_Branches_N); altrimenti la foresta. */
const TREE_STYLE: Record<number, number> = { 23: 1, 60: 2, 109: 3, 147: 4, 199: 5, 492: 3 }

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
  grid: { chunkWidth: number; chunkHeight: number; worldWidth: number; worldHeight: number; surface: number; rock: number },
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
  /** C'è un muro nella tile (fuori dal mondo o in un riquadro non caricato: sì, così non spuntano bordi). */
  const hasWall = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= grid.worldWidth || y >= grid.worldHeight) return true
    const t = at(x, y)
    return !t || wallOf(t[0], t[1]) !== 0
  }
  /** C'è un blocco che si vede (non disattivato da un attuatore). */
  const blockAt = (chunk: TileChunk, i: number) => tileType(chunk, i) !== NO_TILE && (flagsOf(chunk, i) & ACTUATED) === 0

  /** Stile dell'acqua dai blocchi vicini (zone di 8×8 tile); senza un bioma vicino, dalla profondità. */
  const waterStyles = new Map<number, number>()
  const waterStyle = (x: number, y: number) => {
    const key = (y >> 3) * 4096 + (x >> 3)
    const hit = waterStyles.get(key)
    if (hit !== undefined) return hit
    const counts = new Map<number, number>()
    for (let dy = -12; dy <= 12; dy += 2) {
      for (let dx = -12; dx <= 12; dx += 2) {
        const t = at(x + dx, y + dy)
        if (!t) continue
        const style = WATER_BIOME[tileType(t[0], t[1])]
        if (style !== undefined) counts.set(style, (counts.get(style) ?? 0) + 1)
      }
    }
    let style = y > grid.rock ? 8 : y > grid.surface ? 7 : 0
    let best = 3 // almeno qualche blocco del bioma
    for (const [s, n] of counts) {
      if (n > best) {
        best = n
        style = s
      }
    }
    if (style === 6 && y > grid.surface) style = 12 // deserto sotterraneo
    waterStyles.set(key, style)
    return style
  }
  /** Liquido della tile da disegnare con il suo sprite: tipo e quantità ci sono dal formato 3 dei dati. */
  const liquidOf = (chunk: TileChunk, i: number) => {
    if (!vanilla || chunk.stride < 14 || !(flagsOf(chunk, i) & LIQUID)) return null
    const amount = chunk.data.getUint8(i * chunk.stride + 13)
    const type = chunk.data.getUint8(i * chunk.stride + 12)
    return amount > 0 && type < 4 ? { type, amount } : null
  }
  /** Foglio di sprite del blocco della tile, se c'è (e il blocco si vede). */
  const tileSheet = (chunk: TileChunk, i: number) => {
    if (!blockAt(chunk, i)) return null
    const type = tileType(chunk, i)
    return tileSprite(type) ? source.sheet('tiles', type) : null
  }
  /**
   * Il muro della tile si disegna: ha uno sprite, non c'è un liquido davanti (lì il gioco non lo mostra) e il blocco
   * davanti, se c'è, ha il suo sprite (altrimenti di quella tile resterebbe solo il colore del muro). Dietro un blocco
   * il muro si vede dove lo sprite del blocco è trasparente: piattaforme, liane, rametti, bordi.
   */
  const wallSheet = (chunk: TileChunk, i: number) => {
    const wall = wallOf(chunk, i)
    // Dietro un liquido il muro si vede solo se il liquido ha il suo sprite (trasparente)
    if (!wallSprite(wall) || (flagsOf(chunk, i) & LIQUID && !liquidOf(chunk, i))) return null
    if (blockAt(chunk, i) && !tileSheet(chunk, i)) return null
    return source.sheet('walls', wall)
  }
  /** Colore dello sfondo (cielo, caverne) vicino: quello di una tile vicina senza blocco, muro né liquido. */
  const airAround = (x: number, y: number): number | null => {
    for (let r = 1; r <= 3; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
          const t = at(x + dx, y + dy)
          if (!t || !t[0].pixels) continue
          const [chunk, i] = t
          if (blockAt(chunk, i) || wallOf(chunk, i) !== 0 || flagsOf(chunk, i) & LIQUID) continue
          return chunk.pixels![i]
        }
      }
    }
    return null
  }

  // 1. Sfondo dietro i blocchi con uno sprite e senza muro: sotto c'è il colore piatto del blocco (la mappa a pixel),
  //    che dove lo sprite è trasparente si vedrebbe; ci va lo sfondo, come nel gioco
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = at(x, y)
      if (!t) continue
      const [chunk, i] = t
      if (!(tileSheet(chunk, i) || liquidOf(chunk, i)) || wallSheet(chunk, i)) continue
      // Blocco pieno in mezzo ad altri blocchi: lo sprite lo copre tutto (il caso più comune sottoterra)
      if (types.solid[tileType(chunk, i)] && [[0, -1], [0, 1], [-1, 0], [1, 0]].every(([dx, dy]) => {
        const n = at(x + dx, y + dy)
        return n !== null && blockAt(n[0], n[1])
      })) continue
      const fill = airAround(x, y)
      if (fill === null) continue
      const { sx, sy, w, h } = rect(x, y)
      ctx.fillStyle = hex(fill)
      ctx.fillRect(sx, sy, w, h)
    }
  }

  // 2. Muri (32×32, centrati sulla tile e debordanti di 8 pixel per lato), prima dei blocchi come nel gioco
  const wallDrawn = new Uint8Array(cols * (y1 - y0 + 1))
  let walls = 0
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = at(x, y)
      if (!t) continue
      const [chunk, i] = t
      const sheet = wallSheet(chunk, i)
      if (!sheet) continue
      let col = chunk.stride >= 12 ? chunk.data.getUint8(i * chunk.stride + 10) : UNKNOWN_FRAME
      let row = chunk.stride >= 12 ? chunk.data.getUint8(i * chunk.stride + 11) : UNKNOWN_FRAME
      // Non calcolato dal gioco: come per i blocchi, dai vicini con un muro (lo schema dei fogli dei muri, 13×5 pezzi,
      // è quello dei blocchi)
      if (col === UNKNOWN_FRAME || row === UNKNOWN_FRAME) {
        ;[col, row] = blockFrame(hasWall(x, y - 1), hasWall(x, y + 1), hasWall(x - 1, y), hasWall(x + 1, y), variantAt(x, y))
      }
      if (col * 36 + 32 > sheet.naturalWidth || row * 36 + 32 > sheet.naturalHeight) continue
      const { sx, sy, w, h } = rect(x, y)
      ctx.drawImage(sheet, col * 36, row * 36, 32, 32, sx - w / 2, sy - h / 2, w * 2, h * 2)
      wallDrawn[(y - y0) * cols + (x - x0)] = 1
      walls++
    }
  }

  // 3. Le tile vicine ai muri che restano del loro colore (blocco senza sprite, liquido) lo riprendono: i muri debordano
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
        const liquid = (flagsOf(chunk, i) & LIQUID) !== 0 && !liquidOf(chunk, i)
        if (!liquid && (!blockAt(chunk, i) || tileSheet(chunk, i))) continue
        const { sx, sy, w, h } = rect(x, y)
        ctx.fillStyle = hex(chunk.pixels![i])
        ctx.fillRect(sx, sy, w, h)
      }
    }
  }

  // 3b. Liquidi, sopra i muri e sotto i blocchi: alti quanto la loro quantità, trasparenti come nel gioco. In
  //     superficie c'è la riga chiara in cima alla texture; sotto un altro liquido la tile è piena, senza
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = at(x, y)
      if (!t) continue
      const liquid = liquidOf(t[0], t[1])
      if (!liquid) continue
      const style = LIQUID_STYLE[liquid.type] >= 0 ? LIQUID_STYLE[liquid.type] : waterStyle(x, y)
      const sheet = source.sheet('liquids', style)
      if (!sheet) continue
      const above = y > 0 ? at(x, y - 1) : null
      const covered = above !== null && liquidOf(above[0], above[1]) !== null
      const { sx, sy, w, h } = rect(x, y)
      ctx.globalAlpha = LIQUID_ALPHA[liquid.type]
      if (covered) {
        ctx.drawImage(sheet, 0, 8, 16, 8, sx, sy, w, h)
      } else {
        const level = Math.max(1, Math.round((liquid.amount / 255) * 16))
        const dh = Math.max(1, Math.round((h * level) / 16))
        ctx.drawImage(sheet, 0, 0, 16, level, sx, sy + h - dh, w, dh)
      }
      ctx.globalAlpha = 1
    }
  }

  /** Stesso tipo nella tile vicina (fuori dal mondo o in un riquadro non caricato: sì, così non spuntano bordi). */
  const same = (x: number, y: number, type: number) => {
    if (x < 0 || y < 0 || x >= grid.worldWidth || y >= grid.worldHeight) return true
    const t = at(x, y)
    if (!t) return true
    return tileType(t[0], t[1]) === type && (flagsOf(t[0], t[1]) & ACTUATED) === 0
  }

  // 4. Blocchi
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = at(x, y)
      if (!t) continue
      const [chunk, i] = t
      const sheet = tileSheet(chunk, i)
      if (!sheet) continue
      const type = tileType(chunk, i)
      const flags = flagsOf(chunk, i)

      let fx = chunk.data.getInt16(i * chunk.stride + 2, true)
      let fy = chunk.data.getInt16(i * chunk.stride + 4, true)
      // I frame li calcola il gioco (LiveMap, o WorldFrames per il file del mondo). Se mancano ancora, la tabella dei
      // blocchi di Terraria, che va bene per le mod che non hanno uno schema proprio
      if (fx < 0 || fy < 0) {
        if (types.frameImportant[type]) continue
        const [col, row] = blockFrame(same(x, y - 1, type), same(x, y + 1, type), same(x - 1, y, type), same(x + 1, y, type), variantAt(x, y))
        fx = col * 18
        fy = row * 18
      }
      // Tronchi degli alberi: celle da 20×20 (a passi di 22), larghe 2 pixel in più per lato; il foglio ha anche i
      // legni degli altri biomi affiancati, qui si usa quello della foresta
      if (type === TREE && vanilla) {
        if (fx + 20 > sheet.naturalWidth || fy + 20 > sheet.naturalHeight) continue
        const px = z / 16
        ctx.drawImage(sheet, fx, fy, 20, 20, Math.round((x - view.x) * z - 2 * px), Math.round((y - view.y) * z), Math.round(20 * px), Math.round(20 * px))
        continue
      }
      if (fx + 16 > sheet.naturalWidth || fy + 16 > sheet.naturalHeight) continue
      const { sx, sy, w, h } = rect(x, y)
      // Mezzo blocco: la metà alta dello sprite, nella metà bassa della tile (le pendenze per ora restano piene)
      if ((flags & 0x07) === 1) ctx.drawImage(sheet, fx, fy, 16, 8, sx, sy + Math.round(h / 2), w, h - Math.round(h / 2))
      else ctx.drawImage(sheet, fx, fy, 16, 16, sx, sy, w, h)
    }
  }

  // 5. Chiome e rami degli alberi: debordano di qualche tile, quindi si guardano anche le tile appena fuori
  if (!vanilla) return
  /** Stile dell'albero: dal blocco sotto il tronco. */
  const treeStyle = (x: number, y: number) => {
    for (let k = 0; k < 64 && y + k < grid.worldHeight; k++) {
      const t = at(x, y + k)
      if (!t) return 0
      const type = tileType(t[0], t[1])
      if (type !== TREE) return TREE_STYLE[type] ?? 0
    }
    return 0
  }
  const px = z / 16 // pixel dello schermo per pixel della texture
  for (let y = y0; y <= Math.min(grid.worldHeight - 1, y1 + 6); y++) {
    for (let x = Math.max(0, x0 - 4); x <= Math.min(grid.worldWidth - 1, x1 + 4); x++) {
      const t = at(x, y)
      if (!t || tileType(t[0], t[1]) !== TREE) continue
      const [chunk, i] = t
      const fx = chunk.data.getInt16(i * chunk.stride + 2, true)
      const fy = chunk.data.getInt16(i * chunk.stride + 4, true)
      if (fy < 198 || (fx !== 22 && fx !== 44 && fx !== 66)) continue
      const variant = fy >= 242 ? 2 : fy >= 220 ? 1 : 0
      const top = fx === 22
      const style = treeStyle(fx === 44 ? x + 1 : fx === 66 ? x - 1 : x, y)
      const sheet = source.sheet(top ? 'treetops' : 'treebranches', style)
      if (!sheet) continue
      if (top) {
        // Tre varianti affiancate, in celle con 2 pixel di bordo a destra e in basso (il consacrato ne ha nove: tre
        // varianti per tre tonalità, si usa la prima); la chioma poggia sulla tile, centrata
        const stride = style === 3 ? 82 : sheet.naturalWidth / 3
        const w = stride - 2
        const h = sheet.naturalHeight - 2
        const sx = (x - view.x) * z + (8 - w / 2) * px
        const sy = (y - view.y) * z + (16 - h) * px
        ctx.drawImage(sheet, variant * stride, 0, w, h, Math.round(sx), Math.round(sy), Math.round(w * px), Math.round(h * px))
      } else {
        // Due colonne (sinistra, destra) di celle quadrate con 2 pixel di bordo, una riga per variante; il ramo parte
        // dal tronco, centrato sulla tile in altezza
        const stride = sheet.naturalWidth / 2
        const w = stride - 2
        const h = stride - 2
        const left = fx === 44
        const sx = (x - view.x) * z + (left ? 16 - w : 0) * px
        const sy = (y - view.y) * z + (8 - h / 2) * px
        ctx.drawImage(sheet, left ? 0 : stride, variant * stride, w, h, Math.round(sx), Math.round(sy), Math.round(w * px), Math.round(h * px))
      }
    }
  }
}

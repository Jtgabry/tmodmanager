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
/** Formato → byte per tile (1: senza i frame dei muri; 2: senza i liquidi; 3: senza vernice dei muri e rivestimenti). */
const FORMATS: Record<number, number> = { 1: 10, 2: 12, 3: 14, 4: 16 }

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
const tilePaint = (chunk: TileChunk, i: number) => chunk.data.getUint8(i * chunk.stride + 9)
const wallPaint = (chunk: TileChunk, i: number) => (chunk.stride >= 16 ? chunk.data.getUint8(i * chunk.stride + 14) : 0)
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

/** Un foglio di sprite: l'immagine, o una sua copia colorata dalla vernice (un canvas), con le sue dimensioni. */
export type Sheet = CanvasImageSource & { naturalWidth: number; naturalHeight: number }

export type SpriteKind = 'tiles' | 'walls' | 'treetops' | 'treebranches' | 'trunks' | 'shroomtops' | 'liquids'

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
const SAND = 53
/** Larghezza della zona dell'oceano ai lati del mondo, come nel gioco (circa 380 tile). */
const OCEAN_ZONE = 380

/**
 * Alberi di Terraria. I tronchi hanno celle da 20×20 (a passi di 22); cima e rami sono tile del tronco con frame
 * speciali, disegnate con texture a parte (Tree_Tops_N, Tree_Branches_N). L'albero normale (tipo 5) prende tronco e
 * chioma dal bioma; gemma, sakura, salice e cenere hanno i loro.
 */
const TREE = 5
const TREE_TOPS: Record<number, number> = { 583: 22, 584: 23, 585: 24, 586: 25, 587: 26, 588: 27, 589: 28, 596: 29, 616: 30, 634: 31 }
const isTree = (type: number) => type === TREE || TREE_TOPS[type] !== undefined
/** Variante dell'albero normale dal blocco sotto (come TileDrawing.GetTreeVariant): tronco Tiles_5_N, -1 = foresta. */
const treeVariant = (ground: number, y: number, surface: number) => {
  if (ground === 23 || ground === 661) return 0 // corruzione
  if (ground === 60) return y <= surface ? 1 : 5 // giungla, in superficie o sotto
  if (ground === 109 || ground === 492) return 2 // consacrato
  if (ground === 147) return 3 // neve
  if (ground === 199 || ground === 662) return 4 // cremisi
  if (ground === 70) return 6 // funghi
  return -1
}
/** Chioma e rami dell'albero normale per variante: foresta, corruzione, giungla, consacrato, neve, cremisi, giungla sotterranea, funghi. */
const TOPS_BY_VARIANT: Record<number, number> = { [-1]: 0, 0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 13, 6: 14 }
/** Palme (Tiles_323): una riga per bioma della sabbia, +4 per le oasi (lontano dal mare); frameY è la piega del tronco. */
const PALM = 323
/** Piattaforme (TileID.Sets.Platforms): in pendenza fanno da scala, con lo sprite intero e un raccordo sotto. */
const PLATFORMS = new Set([19, 427, 435, 436, 437, 438, 439])
/** Blocchi con i propri pezzi per le pendenze (nastri trasportatori): sprite intero. */
const SLOPE_FRAMES = new Set([421, 422])
/** Blocchi che non fanno scendere il raccordo delle scale (TileID.Sets.BlocksStairs). */
const BLOCKS_STAIRS = new Set([54, 328, 386, 387, 459, 541])
/** Blocchi disegnati sempre pieni, anche se in pendenza (TileID.Sets.DontDrawTileSlopes). */
const NO_SLOPE_DRAW = new Set([137, 138, 235, 388, 476, 630, 631, 664, 665, 711, 712, 713, 714, 715, 716, 723, 726])
const PALM_GROUND: Record<number, number> = { 53: 0, 234: 1, 116: 2, 112: 3 }
/** Funghi giganti (Tiles_72): il cappello è Shroom_Tops, sopra la tile con frameX da 36 in su. */
const MUSHROOM = 72

export type SpriteSource = {
  types: TileTypes
  /** Ci sono anche gli sprite di Terraria. */
  vanilla: boolean
  /** Foglio di sprite del tipo, con la vernice indicata (0 = nessuna), se è pronto (null: non ancora, o non c'è). */
  /** Foglio di sprite, con la vernice; `style` (bioma delle palme) sceglie quali pixel la vernice tinge. */
  sheet: (kind: SpriteKind, type: number, paint?: number, style?: number) => Sheet | null
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
        const type = tileType(t[0], t[1])
        // La sabbia delle spiagge è quella del deserto: nella zona dell'oceano, vicino ai bordi del mondo, non conta
        if (type === SAND && (x < OCEAN_ZONE || x > grid.worldWidth - OCEAN_ZONE)) continue
        const style = WATER_BIOME[type]
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
  /**
   * Liquido senza superficie (niente riga chiara in cima): sopra c'è altro liquido, o un blocco che fa da soffitto
   * (anche in pendenza o mezzo blocco: il lato verso il liquido è pieno).
   */
  const coveredAt = (x: number, y: number) => {
    const above = y > 0 ? at(x, y - 1) : null
    if (!above) return false
    if (liquidOf(above[0], above[1])) return true
    return blockAt(above[0], above[1]) && !!types.solid[tileType(above[0], above[1])]
  }
  /**
   * Liquido dietro un mezzo blocco o un blocco in pendenza: la tile non ne ha, ma nel gioco la parte vuota mostra quello
   * delle tile vicine (sopra, ai lati). Restituisce il vicino da cui prenderlo e se la tile è tutta sommersa.
   */
  const liquidBehind = (x: number, y: number, chunk: TileChunk, i: number) => {
    if (!vanilla || (flagsOf(chunk, i) & 0x07) === 0 || !blockAt(chunk, i)) return null
    for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0]]) {
      const n = at(x + dx, y + dy)
      const liquid = n && liquidOf(n[0], n[1])
      if (n && liquid) return { tile: n, liquid, covered: dy === -1 || coveredAt(x + dx, y) }
    }
    return null
  }
  /** Foglio di sprite del blocco della tile, se c'è (e il blocco si vede). */
  const tileSheet = (chunk: TileChunk, i: number) => {
    if (!blockAt(chunk, i)) return null
    const type = tileType(chunk, i)
    return tileSprite(type) ? source.sheet('tiles', type, tilePaint(chunk, i)) : null
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
    return source.sheet('walls', wall, wallPaint(chunk, i))
  }
  /** Colore della mappa della tile più vicina (entro 3) che soddisfa `match`. */
  const pixelAround = (x: number, y: number, match: (chunk: TileChunk, i: number) => boolean): number | null => {
    for (let r = 1; r <= 3; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
          const t = at(x + dx, y + dy)
          if (!t || !t[0].pixels || !match(t[0], t[1])) continue
          return t[0].pixels[t[1]]
        }
      }
    }
    return null
  }
  /** Colore dello sfondo (cielo, caverne) vicino: quello di una tile vicina senza blocco, muro né liquido. */
  const airAround = (x: number, y: number) =>
    pixelAround(x, y, (chunk, i) => !blockAt(chunk, i) && wallOf(chunk, i) === 0 && !(flagsOf(chunk, i) & LIQUID))
  /** Colore dell'acqua (o di un altro liquido) vicino, come la mappa lo mostra in una tile di solo liquido. */
  const liquidAround = (x: number, y: number) =>
    pixelAround(x, y, (chunk, i) => tileType(chunk, i) === NO_TILE && wallOf(chunk, i) === 0 && liquidOf(chunk, i) !== null)

  // 1. Sfondo dietro i blocchi con uno sprite e senza muro: sotto c'è il colore piatto del blocco (la mappa a pixel),
  //    che dove lo sprite è trasparente si vedrebbe; ci va lo sfondo, come nel gioco
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = at(x, y)
      if (!t) continue
      const [chunk, i] = t
      if (!(tileSheet(chunk, i) || liquidOf(chunk, i)) || wallSheet(chunk, i)) continue
      // Blocco pieno (non mezzo blocco né in pendenza) in mezzo ad altri blocchi: lo sprite lo copre tutto (il caso più
      // comune sottoterra)
      if (types.solid[tileType(chunk, i)] && (flagsOf(chunk, i) & 0x07) === 0 && [[0, -1], [0, 1], [-1, 0], [1, 0]].every(([dx, dy]) => {
        const n = at(x + dx, y + dy)
        return n !== null && blockAt(n[0], n[1])
      })) continue
      // In fondo all'acqua (piante sommerse, pendenze, mezzi blocchi) non c'è aria vicino: il colore della mappa del
      // liquido accanto, come sotto le tile di solo liquido
      let fill = airAround(x, y)
      if (fill === null && (liquidOf(chunk, i) || liquidBehind(x, y, chunk, i))) fill = liquidAround(x, y)
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
      // Il liquido della tile, o quello che si vede dietro un blocco in pendenza o un mezzo blocco
      const own = liquidOf(t[0], t[1])
      const behind = own ? null : liquidBehind(x, y, t[0], t[1])
      const liquid = own ?? behind?.liquid
      if (!liquid) continue
      const style = LIQUID_STYLE[liquid.type] >= 0 ? LIQUID_STYLE[liquid.type] : waterStyle(x, y)
      const sheet = source.sheet('liquids', style)
      if (!sheet) continue
      const covered = behind ? behind.covered : coveredAt(x, y)
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

  /** Primo blocco sotto il tronco (che non sia lo stesso albero): da lì vengono legno e chioma. */
  const treeGround = (x: number, y: number, trunk: number) => {
    for (let k = 0; k < 64 && y + k < grid.worldHeight; k++) {
      const t = at(x, y + k)
      if (!t) return -1
      const type = tileType(t[0], t[1])
      if (type !== trunk) return type
    }
    return -1
  }
  /** Colonna del tronco per le tile dei rami e dei monconi (come TileDrawing.GetTreeBiome). */
  const trunkX = (x: number, fx: number, fy: number) => {
    if (fx === 66 && fy <= 45) x++
    if (fx === 88 && fy >= 66 && fy <= 110) x--
    if (fy >= 198) return fx === 66 ? x - 1 : fx === 44 ? x + 1 : x
    if (fy >= 132) return fx === 22 ? x - 1 : fx === 44 ? x + 1 : x
    return x
  }
  /** Bioma della palma (riga del foglio): dalla sabbia sotto, +4 per le oasi, lontano dalla zona dell'oceano. */
  const palmBiome = (x: number, y: number) => {
    const base = PALM_GROUND[treeGround(x, y, PALM)] ?? 0
    return x > OCEAN_ZONE && x < grid.worldWidth - OCEAN_ZONE ? base + 4 : base
  }

  // 3c. Scale di piattaforme: sotto ogni gradino il gioco disegna, dietro i blocchi, un raccordo verso il gradino
  //     successivo (TileDrawing.DrawBasicTile), nella tile di sotto
  for (let y = y0 - 1; y < y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = at(x, y)
      if (!t) continue
      const [chunk, i] = t
      const type = tileType(chunk, i)
      const slope = (flagsOf(chunk, i) & 0x07) - 1
      if (!PLATFORMS.has(type) || (slope !== 1 && slope !== 2)) continue
      // Il gradino successivo: in basso a destra (pendenza 1) o a sinistra (2), pieno o una piattaforma
      const next = at(slope === 1 ? x + 1 : x - 1, y + 1)
      if (!next) continue
      const nextType = tileType(next[0], next[1])
      const nextShape = flagsOf(next[0], next[1]) & 0x07
      if (nextType === NO_TILE || !(types.solid[nextType] || PLATFORMS.has(nextType)) || nextShape === 1 || nextShape === (slope === 1 ? 3 : 2)) continue
      const below = at(x, y + 1)
      if (below) {
        const belowType = tileType(below[0], below[1])
        const belowShape = flagsOf(below[0], below[1]) & 0x07
        if (belowType !== NO_TILE && (belowShape === 0 || belowShape === (slope === 1 ? 5 : 4)) && BLOCKS_STAIRS.has(belowType)) continue
      }
      const sheet = tileSheet(chunk, i)
      if (!sheet) continue
      const fy = chunk.data.getInt16(i * chunk.stride + 4, true)
      const fx = PLATFORMS.has(nextType) && nextShape === 0 ? (slope === 1 ? 324 : 306) : slope === 1 ? 198 : 162
      if (fy < 0 || fx + 16 > sheet.naturalWidth || fy + 16 > sheet.naturalHeight) continue
      const { sx, sy, w, h } = rect(x, y + 1)
      ctx.drawImage(sheet, fx, fy, 16, 16, sx, sy, w, h)
    }
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
      // (Nelle palme frameY è lo spostamento della piega del tronco: può essere negativo)
      if (fx < 0 || (fy < 0 && type !== PALM)) {
        if (types.frameImportant[type]) continue
        const [col, row] = blockFrame(same(x, y - 1, type), same(x, y + 1, type), same(x - 1, y, type), same(x + 1, y, type), variantAt(x, y))
        fx = col * 18
        fy = row * 18
      }
      // Tronchi degli alberi e delle palme: celle da 20×20 (a passi di 22), larghe 2 pixel in più per lato. Il tronco
      // normale ha il legno del bioma (Tiles_5_N); la palma ha una riga per bioma e si piega di frameY pixel
      if (vanilla && (isTree(type) || type === PALM)) {
        let trunk: Sheet | null = sheet
        let srcY = fy
        let shift = 0
        if (type === TREE) {
          const variant = treeVariant(treeGround(trunkX(x, fx, fy), y, TREE), y, grid.surface)
          if (variant >= 0) trunk = source.sheet('trunks', variant, tilePaint(chunk, i))
        } else if (type === PALM) {
          // Una riga per bioma; con la vernice conta anche il bioma (quali pixel tinge)
          const biome = palmBiome(x, y)
          srcY = biome * 22
          shift = fy
          const paint = tilePaint(chunk, i)
          if (paints(paint)) trunk = source.sheet('tiles', PALM, paint, biome)
        }
        if (!trunk || fx + 20 > trunk.naturalWidth || srcY + 20 > trunk.naturalHeight) continue
        const px = z / 16
        ctx.drawImage(trunk, fx, srcY, 20, 20, Math.round((x - view.x) * z + (shift - 2) * px), Math.round((y - view.y) * z), Math.round(20 * px), Math.round(20 * px))
        continue
      }
      if (fx + 16 > sheet.naturalWidth || fy + 16 > sheet.naturalHeight) continue
      const { sx, sy, w, h } = rect(x, y)
      const shape = flags & 0x07
      // Mezzo blocco: la metà alta dello sprite, nella metà bassa della tile
      if (shape === 1) ctx.drawImage(sheet, fx, fy, 16, 8, sx, sy + Math.round(h / 2), w, h - Math.round(h / 2))
      else if (shape > 1 && !PLATFORMS.has(type) && !SLOPE_FRAMES.has(type) && !NO_SLOPE_DRAW.has(type)) drawSlope(ctx, sheet, fx, fy, shape - 1, (x - view.x) * z, (y - view.y) * z, z / 16)
      else ctx.drawImage(sheet, fx, fy, 16, 16, sx, sy, w, h)
    }
  }

  // 5. Chiome e rami degli alberi, chiome delle palme e cappelli dei funghi: debordano di qualche tile, quindi si
  //    guardano anche le tile appena fuori
  if (!vanilla) return
  const px = z / 16 // pixel dello schermo per pixel della texture
  /** Disegna una parte di una texture con l'angolo in alto a sinistra in (x, y) del mondo, più `dx`, `dy` pixel. */
  const put = (sheet: Sheet, sx: number, sy: number, w: number, h: number, x: number, y: number, dx: number, dy: number) =>
    ctx.drawImage(sheet, sx, sy, w, h, Math.round((x - view.x) * z + dx * px), Math.round((y - view.y) * z + dy * px), Math.round(w * px), Math.round(h * px))
  for (let y = y0; y <= Math.min(grid.worldHeight - 1, y1 + 7); y++) {
    for (let x = Math.max(0, x0 - 5); x <= Math.min(grid.worldWidth - 1, x1 + 5); x++) {
      const t = at(x, y)
      if (!t) continue
      const [chunk, i] = t
      const type = tileType(chunk, i)
      if (!isTree(type) && type !== PALM && type !== MUSHROOM) continue
      if ((flagsOf(chunk, i) & ACTUATED) !== 0) continue
      const fx = chunk.data.getInt16(i * chunk.stride + 2, true)
      const fy = chunk.data.getInt16(i * chunk.stride + 4, true)

      if (type === MUSHROOM) {
        // Cappello: tre varianti da 60×42 (celle da 62), 22 pixel a sinistra e 26 sopra la tile
        if (fx < 36) continue
        const sheet = source.sheet('shroomtops', 0, tilePaint(chunk, i))
        if (sheet) put(sheet, Math.min(2, Math.floor(fy / 18)) * 62, 0, 60, 42, x, y, -22, -26)
        continue
      }
      if (type === PALM) {
        // Chioma: frameX 88, 110, 132 (variante); spiaggia 80×80 (Tree_Tops_15), oasi 114×98 (Tree_Tops_21), una riga
        // per bioma; si sposta con la piega del tronco
        if (fx < 88 || fx > 132) continue
        const variant = fx === 110 ? 1 : fx === 132 ? 2 : 0
        const biome = palmBiome(x, y)
        const oasis = biome >= 4
        const [style, w, h, offX, offY] = oasis ? [21, 114, 98, 48, 2] : [15, 80, 80, 32, 0]
        const sheet = source.sheet('treetops', style, tilePaint(chunk, i), biome)
        if (sheet) put(sheet, variant * (w + 2), (oasis ? biome - 4 : biome) * (h + 2), w, h, x, y, fy - offX, 16 + offY - h)
        continue
      }
      if (fy < 198 || (fx !== 22 && fx !== 44 && fx !== 66)) continue
      const variant = fy >= 242 ? 2 : fy >= 220 ? 1 : 0
      const top = fx === 22
      const style = type === TREE ? TOPS_BY_VARIANT[treeVariant(treeGround(trunkX(x, fx, fy), y, TREE), y, grid.surface)] : TREE_TOPS[type]
      const sheet = source.sheet(top ? 'treetops' : 'treebranches', style, tilePaint(chunk, i))
      if (!sheet) continue
      if (top) {
        // Tre varianti affiancate, in celle con 2 pixel di bordo a destra e in basso (il consacrato ne ha nove: tre
        // varianti per tre tonalità, si usa la prima); la chioma poggia sulla tile, centrata
        const stride = style === 3 ? 82 : sheet.naturalWidth / 3
        const w = stride - 2
        const h = sheet.naturalHeight - 2
        put(sheet, variant * stride, 0, w, h, x, y, 8 - w / 2, 16 - h)
      } else {
        // Due colonne (sinistra, destra) di celle quadrate con 2 pixel di bordo, una riga per variante; il ramo parte
        // dal tronco, centrato sulla tile in altezza
        const stride = sheet.naturalWidth / 2
        const w = stride - 2
        const left = fx === 44
        put(sheet, left ? 0 : stride, variant * stride, w, w, x, y, left ? 16 - w : 0, 8 - w / 2)
      }
    }
  }
}

/** Vernici con un significato a parte (WorldGen.paintColor): ombra, negativa, luminosa. */
const SHADOW = 29
const NEGATIVE = 30
const ILLUMINANT = 31
const PAINTS = 31

/** La vernice cambia l'aspetto dello sprite (la luminosa no: nel gioco cambia solo la luce). */
export const paints = (paint: number) => paint > 0 && paint <= PAINTS && paint !== ILLUMINANT

/**
 * Parte dello sprite che una vernice normale tinge (TreePaintSystemData): erba, alberi e foglie hanno pixel che
 * restano del loro colore (la terra sotto l'erba, il legno sotto le foglie). Un pixel è nel gruppo se tonalità
 * (spostata di `offset`) e saturazione sono negli intervalli; `invert` tinge invece quelli fuori.
 */
export type PaintGroup = { minHue: number; maxHue: number; minSat: number; maxSat: number; offset: number; invert: boolean }
const group = (minHue: number, maxHue: number, minSat: number, maxSat: number, offset: number, invert: boolean): PaintGroup => ({ minHue, maxHue, minSat, maxSat, offset, invert })
const G = {
  dirt: group(0.03, 0.08, 0.38, 0.53, 0, true),
  mud: group(0.42, 0.55, 0.2, 0.27, 0.5, true),
  purity: group(1 / 6, 5 / 6, 0, 1, 0, false),
  corruption: group(0.5, 1, 0.27, 1, 0, false),
  hallow: group(0, 1, 0, 0.34, 0, true),
  snow: group(0, 0.06944445, 0, 1, 0, false),
  crimson: group(1 / 3, 2 / 3, 0, 1, 0, true),
  mushroom: group(0.5, 5 / 6, 0, 1, 0, false),
  cherry: group(5 / 6, 1, 0, 1, 0, false),
  willow: group(0, 0.025, 0, 1, 0, true),
  gem: group(0, 1, 0, 0.0027777778, 0, true),
  palmPurity: group(0.15277778, 0.25, 0.88, 1, 0, false),
  palmCorruption: group(0, 1, 0.4, 1, 0, false),
  palmCrimson: group(1 / 3, 0.5277778, 0, 1, 0.5, false),
  palmHallow: group(0.5, 0.6111111, 0, 1, 0, false),
}
/** Legno degli alberi per variante (-1 foresta, poi corruzione, giungla, consacrato, neve, cremisi, giungla sotterranea, funghi). */
const WOOD = [G.purity, G.corruption, G.purity, G.hallow, G.snow, G.crimson, G.purity, G.mushroom]
/** Palme per bioma della sabbia (le oasi, 4–7, come la spiaggia). */
const PALMS = [G.palmPurity, G.palmCrimson, G.palmHallow, G.palmCorruption]
/** Chiome e rami per numero di texture (Tree_Tops_N, Tree_Branches_N); oltre: come l'erba. */
const FOLIAGE: (PaintGroup | 'palm')[] = [
  G.purity, G.corruption, G.purity, G.hallow, G.snow, G.crimson, G.purity, G.purity, G.purity, G.purity, G.purity,
  G.purity, G.snow, G.purity, G.mushroom, 'palm', G.snow, G.snow, G.snow, G.hallow, G.hallow, 'palm', G.gem, G.gem,
  G.gem, G.gem, G.gem, G.gem, G.gem, G.cherry, G.willow,
]
const GRASS = new Set([0, 2, 23, 109, 199, 477, 492, 633])

/** Gruppo da tingere di un foglio di Terraria (TreePaintSystemData.GetTileSettings e GetTreeFoliageSettings). */
export function paintGroup(kind: SpriteKind, type: number, style = -1): PaintGroup | null {
  if (kind === 'trunks') return WOOD[type + 1] ?? G.purity
  if (kind === 'treetops' || kind === 'treebranches') {
    const g = FOLIAGE[type] ?? G.dirt
    return g === 'palm' ? (PALMS[style] ?? PALMS[style - 4] ?? G.purity) : g
  }
  if (kind !== 'tiles') return null
  if (GRASS.has(type)) return G.dirt
  if (type === 59 || type === 60 || type === 70) return G.mud
  if (type === 5) return WOOD[style + 1] ?? G.purity
  if (type === 323) return PALMS[style] ?? PALMS[style - 4] ?? G.purity
  if (type >= 583 && type <= 589) return G.gem
  if (type === 595 || type === 596) return G.cherry
  if (type === 615 || type === 616 || type === 634) return G.willow
  return null
}

/**
 * Tonalità e saturazione (0–1) calcolate come lo shader: per ogni canale che vale il massimo una tonalità candidata
 * (rosso 6 + (g−b)/d, verde 2 + (b−r)/d, blu 4 + (r−g)/d), la più alta, per 0,166667 (non 1/6 esatto), parte
 * frazionaria. Grigi: 0, 0.
 */
function hueSat(r: number, g: number, b: number): [number, number] {
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (d === 0) return [0, 0]
  const h = Math.max(r >= max ? 6 + (g - b) / d : 0, g >= max ? 2 + (b - r) / d : 0, b >= max ? 4 + (r - g) / d : 0) * SIXTH
  return [h - Math.floor(h), d / max]
}
/** La costante dello shader per dividere per 6 (0,166667 in float32). */
const SIXTH = Math.fround(0.166667)

/**
 * Colora i pixel RGBA di un foglio di sprite con una vernice, come lo shader del gioco (TileShader, una passata per
 * vernice). Su ogni pixel contano il canale più chiaro M e il più scuro m: le vernici normali mettono M, m o la loro
 * media nei tre canali (le intense m×0,4), le speciali sono grigi o marroni da M e m, la negativa inverte. Nell'erba,
 * negli alberi e nelle foglie (`group`) le normali tingono solo una parte dei pixel. I conti sono sui colori
 * premoltiplicati per l'alfa, come le texture del gioco.
 */
export function paintPixels(data: Uint8ClampedArray, paint: number, group: PaintGroup | null = null, wall = false) {
  if (!paints(paint)) return
  const deep = paint >= 13 && paint <= 24
  // Canali delle vernici colorate: 0 = M, 1 = media, 2 = m (per rosso, arancione… fino a rosa)
  const PATTERN = [[0, 2, 2], [0, 1, 2], [0, 0, 2], [1, 0, 2], [2, 0, 2], [2, 0, 1], [2, 0, 0], [2, 1, 0], [2, 2, 0], [1, 2, 0], [0, 2, 0], [0, 2, 1]]
  const pattern = paint <= 24 ? PATTERN[(paint - 1) % 12] : null
  const special = group && paint <= 12 ? group : null
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255
    if (alpha === 0) continue
    const r = (data[i] / 255) * alpha
    const g = (data[i + 1] / 255) * alpha
    const b = (data[i + 2] / 255) * alpha
    if (special) {
      const [hue, sat] = hueSat(r, g, b)
      const h = hue + special.offset - Math.floor(hue + special.offset)
      const inside = sat >= special.minSat && sat <= special.maxSat && h >= special.minHue && h <= special.maxHue
      if (inside === special.invert) continue
    }
    const M = Math.max(r, g, b)
    const m = Math.min(r, g, b)
    let out: [number, number, number]
    if (pattern) {
      const lo = deep ? m * 0.4 : m
      const v = [M, (M + lo) / 2, lo]
      out = [v[pattern[0]], v[pattern[1]], v[pattern[2]]]
    } else if (paint === 25) {
      out = [(M + m) * 0.15, (M + m) * 0.15, (M + m) * 0.15] // nera
    } else if (paint === 26) {
      const w = (0.7 * M + 0.3 * m) * (2 - (M + m) / 2) // bianca
      out = [w, w, w]
    } else if (paint === 27) {
      out = [(M + m) / 2, (M + m) / 2, (M + m) / 2] // grigia
    } else if (paint === 28) {
      out = [M, M * 0.7, M * 0.49] // marrone
    } else if (paint === SHADOW) {
      out = [(M + m) * 0.025, (M + m) * 0.025, (M + m) * 0.025]
    } else if (paint === NEGATIVE) {
      // Sui muri il gioco la attenua (più scura)
      out = M === 0 ? [r, g, b] : wall ? [Math.max(0, 0.75 - 2 * r), Math.max(0, 0.75 - 2 * g), Math.max(0, 0.75 - 2 * b)] : [1 - r, 1 - g, 1 - b]
    } else {
      continue
    }
    data[i] = (out[0] / alpha) * 255
    data[i + 1] = (out[1] / alpha) * 255
    data[i + 2] = (out[2] / alpha) * 255
  }
}

/**
 * Blocco in pendenza come lo disegna il gioco (TileDrawing.DrawSingleTile): 8 strisce verticali da 2 pixel della
 * texture, a scaletta, più una riga piena di 2 pixel sul lato pieno. Pendenze 1 e 2: pieno in basso (a sinistra, a
 * destra), con la parte alta dello sprite spostata in giù; 3 e 4: pieno in alto, con la parte bassa spostata in su.
 */
export function drawSlope(ctx: CanvasRenderingContext2D, sheet: CanvasImageSource, fx: number, fy: number, slope: number, x: number, y: number, px: number) {
  const put = (srcX: number, srcY: number, w: number, h: number, dx: number, dy: number) => {
    const sx = Math.round(x + dx * px)
    const sy = Math.round(y + dy * px)
    ctx.drawImage(sheet, fx + srcX, fy + srcY, w, h, sx, sy, Math.round(x + (dx + w) * px) - sx, Math.round(y + (dy + h) * px) - sy)
  }
  for (let q = 0; q < 8; q++) {
    const col = slope === 1 || slope === 3 ? q * 2 : 14 - q * 2
    if (slope <= 2) put(col, 0, 2, 14 - q * 2, col, q * 2)
    else put(col, q * 2, 2, 16 - q * 2, col, 0)
  }
  const row = slope <= 2 ? 14 : 0
  put(0, row, 16, 2, 0, row)
}

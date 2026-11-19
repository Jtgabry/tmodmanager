import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { modBlockColors } from './modMapColors.js'
import { encodePng } from './png.js'
import { type ModBlocks, overlayModBlocks, readModBlocks } from './twld.js'
import { type MapColors, readWorldHeader, renderWorld } from './worldFile.js'
import { TILE_FORMAT, WorldTileSink } from './worldTiles.js'

/**
 * Disegna la mappa di un file del mondo nello stesso formato di LiveMap (vedi addons/LiveMap):
 *   manifest.json · chunks/{cx}_{cy}.png (200×150 tile) · overview.png (1 pixel ogni 4×4 tile)
 *   tiles/{cx}_{cy}.bin e types.json: i dati grezzi delle tile, per gli sprite da vicino (worldTiles.ts)
 * Un riquadro identico a quello della volta prima non si riscrive e tiene la sua versione, così il browser
 * riscarica solo le zone cambiate. Gira in un worker thread (worldFileWorker.ts): l'agent non si blocca.
 */

export const CHUNK_WIDTH = 200
export const CHUNK_HEIGHT = 150
const OVERVIEW_SCALE = 4

export type WorldFileSource = { file: string; mtimeMs: number; size: number; twld?: { mtimeMs: number; size: number } | null }

export type RenderJob = {
  worldPath: string
  source: WorldFileSource
  outDir: string
  colorsPath: string
  /** tModLoader: il .twld accanto al .wld (blocchi delle mod) e la cartella delle mod (per i loro colori). */
  twldPath?: string | null
  modsDir?: string | null
}

/** Esito della lettura dei blocchi delle mod (.twld). */
export type ModBlocksInfo = { tiles: number; walls: number; fromTextures: number; error: string | null }

type PreviousManifest = { cols?: number; rows?: number; chunks?: number[]; hashes?: string[]; tileData?: number; overview?: { version?: number; hash?: string } }

const nextVersion = (previous: number) => Math.max(previous + 1, Date.now())
const hashOf = (png: Buffer) => createHash('sha256').update(png).digest('hex').slice(0, 16)

async function writeAtomic(path: string, data: Buffer | string) {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, path)
}

export async function renderWorldFile(job: RenderJob): Promise<{ width: number; height: number; chunks: number }> {
  const [buf, colors] = await Promise.all([readFile(job.worldPath), readFile(job.colorsPath, 'utf8').then((t) => JSON.parse(t) as MapColors)])
  const header = readWorldHeader(buf)
  const { width, height } = header
  await mkdir(job.outDir, { recursive: true })

  // tModLoader: i blocchi delle mod stanno nel .twld. Se non si legge, resta la mappa vanilla (con l'errore)
  let modBlocks: ModBlocksInfo | null = null
  let blocks: ModBlocks | null = null
  if (job.twldPath) {
    try {
      blocks = readModBlocks(await readFile(job.twldPath))
    } catch (err) {
      modBlocks = { tiles: 0, walls: 0, fromTextures: 0, error: err instanceof Error ? err.message : String(err) }
    }
  }
  // Mappa a pixel e, insieme, i dati grezzi delle tile (con i blocchi delle mod del .twld)
  const sink = new WorldTileSink(width, height, CHUNK_WIDTH, CHUNK_HEIGHT, header.frameImportant, { tiles: colors.tileLookup.length, walls: colors.wallLookup.length }, blocks)
  const { pixels, layers } = renderWorld(buf, header, colors, sink)
  if (job.twldPath && !modBlocks) {
    try {
      if (blocks) {
        const used = { tiles: blocks.tiles, walls: blocks.walls }
        const { colorOf, fromTextures } = await modBlockColors(used.tiles, used.walls, job.modsDir ?? null, join(job.outDir, 'mod-colors.json'))
        overlayModBlocks(pixels, layers, width, height, blocks, colorOf)
        modBlocks = { tiles: used.tiles.length, walls: used.walls.length, fromTextures, error: null }
      }
    } catch (err) {
      modBlocks = { tiles: 0, walls: 0, fromTextures: 0, error: err instanceof Error ? err.message : String(err) }
    }
  }
  const cols = Math.ceil(width / CHUNK_WIDTH)
  const rows = Math.ceil(height / CHUNK_HEIGHT)

  let previous: PreviousManifest = {}
  try {
    previous = JSON.parse(await readFile(join(job.outDir, 'manifest.json'), 'utf8')) as PreviousManifest
  } catch {
    // prima volta
  }
  const sameGrid = previous.cols === cols && previous.rows === rows
  const chunksDir = join(job.outDir, 'chunks')
  const tilesDir = join(job.outDir, 'tiles')
  await mkdir(chunksDir, { recursive: true })
  await mkdir(tilesDir, { recursive: true })
  if (!sameGrid) {
    for (const f of await readdir(chunksDir)) await rm(join(chunksDir, f), { force: true })
    for (const f of await readdir(tilesDir)) await rm(join(tilesDir, f), { force: true })
  }
  // Riquadri del formato vecchio (senza dati delle tile): si riscrivono tutti
  const sameFormat = sameGrid && previous.tileData === TILE_FORMAT

  const versions: number[] = []
  const hashes: string[] = []
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const i = cy * cols + cx
      const w = Math.min(CHUNK_WIDTH, width - cx * CHUNK_WIDTH)
      const h = Math.min(CHUNK_HEIGHT, height - cy * CHUNK_HEIGHT)
      const png = encodePng(pixels, w, h, width, cy * CHUNK_HEIGHT * width + cx * CHUNK_WIDTH)
      const tiles = sink.chunks.get(i)
      const hash = tiles ? `${hashOf(png)}${tiles.hash}` : hashOf(png)
      if (sameFormat && previous.hashes?.[i] === hash && previous.chunks?.[i]) {
        versions.push(previous.chunks[i])
      } else {
        await writeAtomic(join(chunksDir, `${cx}_${cy}.png`), png)
        if (tiles) await writeAtomic(join(tilesDir, `${cx}_${cy}.bin`), tiles.gzip)
        versions.push(nextVersion(sameGrid ? (previous.chunks?.[i] ?? 0) : 0))
      }
      hashes.push(hash)
    }
  }

  // Panoramica: un campione ogni 4×4 tile
  const ow = Math.ceil(width / OVERVIEW_SCALE)
  const oh = Math.ceil(height / OVERVIEW_SCALE)
  const small = new Uint32Array(ow * oh)
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) small[y * ow + x] = pixels[y * OVERVIEW_SCALE * width + x * OVERVIEW_SCALE]
  const overview = encodePng(small, ow, oh)
  const overviewHash = hashOf(overview)
  let overviewVersion = previous.overview?.version ?? 0
  if (previous.overview?.hash !== overviewHash || !overviewVersion) {
    await writeAtomic(join(job.outDir, 'overview.png'), overview)
    overviewVersion = nextVersion(overviewVersion)
  }

  const manifest = {
    format: 1,
    world: { name: header.name, id: header.id, width, height, spawnX: header.spawnX, spawnY: header.spawnY, surface: header.surface, rock: header.rock },
    chunkWidth: CHUNK_WIDTH,
    chunkHeight: CHUNK_HEIGHT,
    cols,
    rows,
    chunks: versions,
    hashes,
    overview: { scale: OVERVIEW_SCALE, width: ow, height: oh, version: overviewVersion, hash: overviewHash },
    progress: { drawn: cols * rows, total: cols * rows },
    tileData: TILE_FORMAT,
    // Da quale file: se cambia (salvataggio del mondo), la mappa si ridisegna
    source: job.source,
    terraria: colors.terraria,
    modBlocks,
  }
  await writeAtomic(join(job.outDir, 'types.json'), JSON.stringify(sink.types))
  await writeAtomic(join(job.outDir, 'manifest.json'), JSON.stringify(manifest))
  return { width, height, chunks: cols * rows }
}

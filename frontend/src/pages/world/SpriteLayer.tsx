import { useEffect, useRef, useState } from 'react'
import type { MapSource, WorldMapManifest } from '../../lib/types'
import { chunkUrl, spriteUrl, tilesUrl, useTileTypes } from '../../lib/worldMap'
import { decodeTileChunk, drawSprites, imagePixels, paintPixels, paints, type Sheet, type SpriteKind, type TileChunk } from './tileSprites'

/** Da quanti pixel dello schermo per tile si vedono gli sprite (sotto sarebbero illeggibili). */
export const SPRITE_ZOOM = 8
/** Riquadri tenuti in memoria (ognuno circa 360 KB): quelli visti da poco. */
const MAX_CHUNKS = 24
/** Gli sprite si disegnano una volta in blocchi di 32×32 tile, a 16 pixel per tile (512×512, 1 MB l'uno). */
const BLOCK = 32
const BLOCK_PX = BLOCK * 16
const MAX_BLOCKS = 64

type Loaded = { version: number; chunk: TileChunk | null; usedAt: number }
type Block = { canvas: HTMLCanvasElement; stamp: number; usedAt: number }

/**
 * Sprite di blocchi e muri sopra la mappa a pixel, da vicino (con i dati delle tile: da LiveMap, o ricavati dal file
 * del mondo). Carica i dati solo dei
 * riquadri visibili; finché non arrivano, e per i blocchi senza sprite, resta il colore della mappa. Gli sprite si
 * disegnano in blocchi di 32×32 tile tenuti da parte: spostando la mappa si copiano solo quelli.
 */
export default function SpriteLayer({
  serverId,
  source,
  manifest,
  view,
  size,
  typesVersion,
  vanilla,
  visible,
}: {
  serverId: string
  source: MapSource
  manifest: WorldMapManifest
  view: { x: number; y: number; zoom: number }
  size: { w: number; h: number }
  typesVersion: number
  /** Ci sono anche gli sprite di Terraria (versione delle texture del gioco). */
  vanilla: string | null
  visible: { cx: number; cy: number; version: number }[]
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const chunks = useRef(new Map<string, Loaded>())
  const loading = useRef(new Set<string>())
  const sheets = useRef(new Map<string, HTMLImageElement | 'loading' | 'missing'>())
  /** Copie colorate dalle vernici, fatte quando servono. */
  const painted = useRef(new Map<string, Sheet | null>())
  const blocks = useRef(new Map<string, Block>())
  /** Cresce quando arrivano dati o sprite: i blocchi disegnati prima vanno rifatti. */
  const stamp = useRef(0)
  const [tick, setTick] = useState(0)
  const redraw = useRef<ReturnType<typeof setTimeout> | null>(null)
  const types = useTileTypes(serverId, source, typesVersion)

  /** Nuovi dati o sprite: si ridisegna, raggruppando gli arrivi ravvicinati (all'inizio arrivano a decine). */
  const changed = () => {
    stamp.current++
    if (redraw.current) return
    redraw.current = setTimeout(() => {
      redraw.current = null
      setTick((t) => t + 1)
    }, 80)
  }
  useEffect(() => () => {
    if (redraw.current) clearTimeout(redraw.current)
  }, [])

  // Dati dei riquadri visibili (e della loro mappa a pixel, per riempire dietro gli sprite)
  const wanted = visible.map((c) => `${c.cx}_${c.cy}@${c.version}`).join(',')
  useEffect(() => {
    const now = Date.now()
    for (const { cx, cy, version } of visible) {
      const key = `${cx}_${cy}`
      const have = chunks.current.get(key)
      if (have?.version === version) {
        have.usedAt = now
        continue
      }
      const job = `${key}@${version}`
      if (loading.current.has(job)) continue
      loading.current.add(job)
      void (async () => {
        let chunk: TileChunk | null = null
        try {
          const res = await fetch(tilesUrl(serverId, source, cx, cy, version), { credentials: 'same-origin' })
          const decoded = res.ok ? await decodeTileChunk(await res.arrayBuffer()) : null
          if (decoded) chunk = { ...decoded, pixels: await imagePixels(chunkUrl(serverId, source, cx, cy, version)) }
        } catch {
          // riquadro non disponibile: resta la mappa a pixel
        }
        loading.current.delete(job)
        chunks.current.set(key, { version, chunk, usedAt: Date.now() })
        // I meno usati di recente lasciano il posto
        if (chunks.current.size > MAX_CHUNKS) {
          const oldest = [...chunks.current.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt).slice(0, chunks.current.size - MAX_CHUNKS)
          for (const [k] of oldest) chunks.current.delete(k)
        }
        changed()
      })()
    }
    // `wanted` riassume `visible`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, serverId, source])

  // Disegno: a ogni spostamento, quando arrivano dati o sprite
  useEffect(() => {
    const el = canvas.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx) return
    const dpr = window.devicePixelRatio || 1
    if (el.width !== Math.round(size.w * dpr) || el.height !== Math.round(size.h * dpr)) {
      el.width = Math.round(size.w * dpr)
      el.height = Math.round(size.h * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)
    const tileTypes = types.data
    if (!tileTypes) return

    /** Copia del foglio colorata dalla vernice (una volta per foglio e vernice). */
    const paintedSheet = (key: string, image: HTMLImageElement, paint: number): Sheet | null => {
      const pkey = `${key}:${paint}`
      if (painted.current.has(pkey)) return painted.current.get(pkey)!
      let result: Sheet | null = null
      try {
        const c = document.createElement('canvas')
        c.width = image.naturalWidth
        c.height = image.naturalHeight
        const pctx = c.getContext('2d', { willReadFrequently: true })
        if (pctx) {
          pctx.drawImage(image, 0, 0)
          const data = pctx.getImageData(0, 0, c.width, c.height)
          paintPixels(data.data, paint)
          pctx.putImageData(data, 0, 0)
          result = Object.assign(c, { naturalWidth: c.width, naturalHeight: c.height })
        }
      } catch {
        result = null
      }
      painted.current.set(pkey, result)
      return result
    }
    const sheet = (kind: SpriteKind, type: number, paint = 0): Sheet | null => {
      const key = `${kind}:${type}`
      const have = sheets.current.get(key)
      if (have instanceof HTMLImageElement) return paints(paint) ? (paintedSheet(key, have, paint) ?? have) : have
      if (have) return null
      const tree = kind !== 'tiles' && kind !== 'walls'
      const isVanilla = tree || type < (kind === 'tiles' ? tileTypes.vanillaTiles : tileTypes.vanillaWalls)
      if (isVanilla ? !vanilla : !(kind === 'tiles' ? tileTypes.modTiles : tileTypes.modWalls)[String(type)]) {
        sheets.current.set(key, 'missing')
        return null
      }
      sheets.current.set(key, 'loading')
      const image = new Image()
      image.onload = () => {
        sheets.current.set(key, image)
        changed()
      }
      image.onerror = () => sheets.current.set(key, 'missing')
      image.src = spriteUrl(serverId, source, kind, type, typesVersion)
      return null
    }
    const spriteSource = { types: tileTypes, vanilla: vanilla !== null, sheet, chunk: (cx: number, cy: number) => chunks.current.get(`${cx}_${cy}`)?.chunk ?? null }
    const grid = {
      chunkWidth: manifest.chunkWidth,
      chunkHeight: manifest.chunkHeight,
      worldWidth: manifest.world.width,
      worldHeight: manifest.world.height,
      surface: manifest.world.surface,
      rock: manifest.world.rock,
    }

    const now = Date.now()
    const z = view.zoom
    const bx0 = Math.max(0, Math.floor(view.x / BLOCK))
    const by0 = Math.max(0, Math.floor(view.y / BLOCK))
    const bx1 = Math.min(Math.ceil(manifest.world.width / BLOCK) - 1, Math.floor((view.x + size.w / z) / BLOCK))
    const by1 = Math.min(Math.ceil(manifest.world.height / BLOCK) - 1, Math.floor((view.y + size.h / z) / BLOCK))
    ctx.imageSmoothingEnabled = false
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        // Senza i dati del riquadro non c'è niente da disegnare (neanche in un blocco fatto prima)
        if (!spriteSource.chunk(Math.floor((bx * BLOCK) / grid.chunkWidth), Math.floor((by * BLOCK) / grid.chunkHeight))) continue
        const key = `${bx}_${by}`
        let block = blocks.current.get(key)
        if (!block || block.stamp !== stamp.current) {
          const c = block?.canvas ?? document.createElement('canvas')
          c.width = BLOCK_PX
          c.height = BLOCK_PX
          const bctx = c.getContext('2d')
          if (!bctx) continue
          bctx.clearRect(0, 0, BLOCK_PX, BLOCK_PX)
          drawSprites(bctx, { x: bx * BLOCK, y: by * BLOCK, zoom: 16 }, { w: BLOCK_PX, h: BLOCK_PX }, grid, spriteSource)
          block = { canvas: c, stamp: stamp.current, usedAt: now }
          blocks.current.set(key, block)
        }
        block.usedAt = now
        const sx = Math.round((bx * BLOCK - view.x) * z)
        const sy = Math.round((by * BLOCK - view.y) * z)
        const ex = Math.round(((bx + 1) * BLOCK - view.x) * z)
        const ey = Math.round(((by + 1) * BLOCK - view.y) * z)
        ctx.drawImage(block.canvas, sx, sy, ex - sx, ey - sy)
      }
    }
    if (blocks.current.size > MAX_BLOCKS) {
      const oldest = [...blocks.current.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt).slice(0, blocks.current.size - MAX_BLOCKS)
      for (const [k] of oldest) blocks.current.delete(k)
    }
  }, [view, size, tick, types.data, manifest, serverId, source, typesVersion, vanilla])

  return <canvas ref={canvas} className="world-map-sprites" style={{ width: size.w, height: size.h }} aria-hidden="true" />
}

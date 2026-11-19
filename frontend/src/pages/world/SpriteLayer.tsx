import { useEffect, useRef, useState } from 'react'
import type { WorldMapManifest } from '../../lib/types'
import { chunkUrl, spriteUrl, tilesUrl, useTileTypes } from '../../lib/worldMap'
import { decodeTileChunk, drawSprites, imagePixels, type SpriteKind, type TileChunk } from './tileSprites'

/** Da quanti pixel dello schermo per tile si vedono gli sprite (sotto sarebbero illeggibili). */
export const SPRITE_ZOOM = 8
/** Riquadri tenuti in memoria (ognuno circa 300 KB): quelli visti da poco. */
const MAX_CHUNKS = 24

type Loaded = { version: number; chunk: TileChunk | null; usedAt: number }

/**
 * Sprite di blocchi e muri sopra la mappa a pixel, da vicino (LiveMap con i dati delle tile). Carica i dati solo dei
 * riquadri visibili; finché non arrivano, e per i blocchi senza sprite, resta il colore della mappa.
 */
export default function SpriteLayer({
  serverId,
  manifest,
  view,
  size,
  typesVersion,
  visible,
}: {
  serverId: string
  manifest: WorldMapManifest
  view: { x: number; y: number; zoom: number }
  size: { w: number; h: number }
  typesVersion: number
  visible: { cx: number; cy: number; version: number }[]
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const chunks = useRef(new Map<string, Loaded>())
  const loading = useRef(new Set<string>())
  const sheets = useRef(new Map<string, HTMLImageElement | 'loading' | 'missing'>())
  const [tick, setTick] = useState(0)
  const types = useTileTypes(serverId, typesVersion)

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
          const res = await fetch(tilesUrl(serverId, cx, cy, version), { credentials: 'same-origin' })
          const decoded = res.ok ? await decodeTileChunk(await res.arrayBuffer()) : null
          if (decoded) chunk = { ...decoded, pixels: await imagePixels(chunkUrl(serverId, 'livemap', cx, cy, version)) }
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
        setTick((t) => t + 1)
      })()
    }
    // `wanted` riassume `visible`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, serverId])

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
    if (!types.data) return

    const sheet = (kind: SpriteKind, type: number) => {
      const key = `${kind}:${type}`
      const have = sheets.current.get(key)
      if (have instanceof HTMLImageElement) return have
      if (have) return null
      if (!(kind === 'tiles' ? types.data.modTiles : types.data.modWalls)[String(type)]) {
        sheets.current.set(key, 'missing')
        return null
      }
      sheets.current.set(key, 'loading')
      const image = new Image()
      image.onload = () => {
        sheets.current.set(key, image)
        setTick((t) => t + 1)
      }
      image.onerror = () => sheets.current.set(key, 'missing')
      image.src = spriteUrl(serverId, kind, type, typesVersion)
      return null
    }
    drawSprites(
      ctx,
      view,
      size,
      { chunkWidth: manifest.chunkWidth, chunkHeight: manifest.chunkHeight, worldWidth: manifest.world.width, worldHeight: manifest.world.height },
      { types: types.data, sheet, chunk: (cx, cy) => chunks.current.get(`${cx}_${cy}`)?.chunk ?? null },
    )
  }, [view, size, tick, types.data, manifest, serverId, typesVersion])

  return <canvas ref={canvas} className="world-map-sprites" style={{ width: size.w, height: size.h }} aria-hidden="true" />
}

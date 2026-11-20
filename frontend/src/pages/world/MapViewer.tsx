import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { chunkUrl, overviewUrl } from '../../lib/worldMap'
import type { MapPlayer, MapSource, WorldMapManifest } from '../../lib/types'
import SpriteLayer, { SPRITE_ZOOM } from './SpriteLayer'
import { t } from '../../i18n'

/** Vista: tile in alto a sinistra e pixel dello schermo per tile. */
type View = { x: number; y: number; zoom: number }

type Tile = { x: number; y: number }

/** Editor del mondo: pennello attivo (col tasto sinistro si disegna invece di trascinare) e tile segnate. */
export type MapPaint = {
  /** Lato del pennello in tile (quadrato centrato sul cursore). */
  brush: number
  /** Gomma: le tile segnate sono rosse. */
  erase: boolean
  /** Fine del tratto: le tile toccate, senza doppioni. */
  onStroke: (tiles: Tile[]) => void
}

/** Tile modificate in attesa che la mappa le ridisegni. */
export type MapMark = Tile & { erase: boolean }

/** Tile del pennello di lato `brush` centrato su (x, y). */
function brushTiles(x: number, y: number, brush: number): Tile[] {
  const start = -Math.floor((brush - 1) / 2)
  const tiles: Tile[] = []
  for (let dy = 0; dy < brush; dy++) for (let dx = 0; dx < brush; dx++) tiles.push({ x: x + start + dx, y: y + start + dy })
  return tiles
}

/** Tile della linea da a a b (Bresenham): un trascinamento veloce non lascia buchi. */
function line(a: Tile, b: Tile): Tile[] {
  const tiles: Tile[] = []
  const dx = Math.abs(b.x - a.x)
  const dy = -Math.abs(b.y - a.y)
  const sx = a.x < b.x ? 1 : -1
  const sy = a.y < b.y ? 1 : -1
  let { x, y } = a
  let err = dx + dy
  for (;;) {
    tiles.push({ x, y })
    if (x === b.x && y === b.y) return tiles
    const e2 = 2 * err
    if (e2 >= dy) {
      err += dy
      x += sx
    }
    if (e2 <= dx) {
      err += dx
      y += sy
    }
  }
}

const MAX_ZOOM = 16
/** Colori dei team di Terraria (0 = nessun team). */
const TEAM_COLOR = ['#f1e6d6', '#ff5a5a', '#5adf6e', '#5a9bff', '#ffd84a', '#e46cff']

/** Strato del mondo: dove si trova la tile (x, y), per la riga delle coordinate. */
function layerOf(world: WorldMapManifest['world'], y: number) {
  if (y < world.surface * 0.35) return t('space')
  if (y < world.surface) return t('surface')
  if (y < world.rock) return t('underground')
  if (y > world.height - 200) return t('underworld')
  return t('caverns')
}

/**
 * Mappa a riquadri: trascinamento, zoom con rotella, pizzico o pulsanti, giocatori sopra.
 * Da lontano si vede la panoramica (un'immagine sola); avvicinandosi si caricano solo i riquadri visibili,
 * e ciascuno si ricarica quando la sua versione cambia. Molto da vicino blocchi e muri hanno i loro sprite (SpriteLayer,
 * con i dati delle tile di LiveMap o del file del mondo): quelli delle mod sempre, quelli di Terraria se il pannello ha le texture del gioco.
 */
export default function MapViewer({
  serverId,
  source,
  manifest,
  players,
  focus,
  typesVersion = null,
  vanillaSprites = null,
  paint = null,
  marks = [],
}: {
  serverId: string
  source: MapSource
  manifest: WorldMapManifest
  players: MapPlayer[]
  /** Giocatore su cui centrarsi (cambia → la vista si sposta). */
  focus: { name: string; at: number } | null
  /** LiveMap con i dati delle tile: versione dei tipi di blocco (per gli sprite da vicino). */
  typesVersion?: number | null
  /** Versione delle texture di Terraria nel pannello (anche i blocchi vanilla hanno lo sprite), oppure null. */
  vanillaSprites?: string | null
  /** Editor del mondo: col pennello il tasto sinistro (o un dito) disegna; si sposta col destro o il centrale. */
  paint?: MapPaint | null
  /** Tile modificate dall'editor, segnate finché la mappa non le ridisegna. */
  marks?: MapMark[]
}) {
  const { world, chunkWidth: cw, chunkHeight: ch, cols, rows, overview } = manifest
  const frame = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState<View | null>(null)
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const playersRef = useRef(players)
  /** Tratto del pennello in corso: puntatore, ultima tile, tile toccate ("x,y"). */
  const stroke = useRef<{ pointer: number; last: Tile; tiles: Map<string, Tile> } | null>(null)
  const [strokeTiles, setStrokeTiles] = useState<Tile[]>([])
  const handledFocus = useRef<number | null>(null)

  const fitZoom = size.w && size.h ? Math.min(size.w / world.width, size.h / world.height) : 1
  const minZoom = fitZoom * 0.5

  /** Vista con zoom e posizione nei limiti: il mondo non esce mai del tutto dallo schermo. */
  const clamp = useCallback(
    (v: View): View => {
      const zoom = Math.min(MAX_ZOOM, Math.max(minZoom, v.zoom))
      const vw = size.w / zoom
      const vh = size.h / zoom
      return {
        zoom,
        x: Math.min(world.width - vw * 0.5, Math.max(-vw * 0.5, v.x)),
        y: Math.min(world.height - vh * 0.5, Math.max(-vh * 0.5, v.y)),
      }
    },
    [minZoom, size.w, size.h, world.width, world.height],
  )

  const centerOn = useCallback(
    (tx: number, ty: number, zoom: number) => setView(clamp({ zoom, x: tx - size.w / zoom / 2, y: ty - size.h / zoom / 2 })),
    [clamp, size.w, size.h],
  )

  const fit = useCallback(() => centerOn(world.width / 2, world.height / 2, fitZoom), [centerOn, fitZoom, world.width, world.height])

  // Dimensioni del riquadro della mappa
  useLayoutEffect(() => {
    const el = frame.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const { width: w, height: h } = entry.contentRect
      setSize({ w, h })
      // Prima vista: lo spawn, abbastanza vicino da riconoscere i blocchi
      if (w > 0) setView((v) => v ?? { zoom: 2, x: world.spawnX - w / 4, y: world.spawnY - h / 4 })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [world.spawnX, world.spawnY])

  useEffect(() => {
    playersRef.current = players
  })

  // Centrarsi su un giocatore scelto dall'elenco (solo quando cambia la richiesta, non a ogni aggiornamento delle posizioni)
  useEffect(() => {
    if (!focus || focus.at === handledFocus.current || !size.w) return
    handledFocus.current = focus.at
    const p = playersRef.current.find((pl) => pl.name === focus.name)
    if (p) setView((v) => clamp({ zoom: Math.max(v?.zoom ?? 2, 2), x: p.x - size.w / Math.max(v?.zoom ?? 2, 2) / 2, y: p.y - size.h / Math.max(v?.zoom ?? 2, 2) / 2 }))
  }, [focus, clamp, size.w, size.h])

  const zoomAt = useCallback(
    (factor: number, sx: number, sy: number) =>
      setView((v) => {
        if (!v) return v
        const zoom = Math.min(MAX_ZOOM, Math.max(minZoom, v.zoom * factor))
        // La tile sotto il cursore resta sotto il cursore
        const tx = v.x + sx / v.zoom
        const ty = v.y + sy / v.zoom
        return clamp({ zoom, x: tx - sx / zoom, y: ty - sy / zoom })
      }),
    [clamp, minZoom],
  )

  // Rotella: listener nativo, perché quello di React è passivo e non può bloccare lo scorrimento della pagina
  useEffect(() => {
    const el = frame.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === frame.current?.parentElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const local = (e: React.PointerEvent) => {
    const rect = frame.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const tileAt = (p: { x: number; y: number }): Tile | null => (view ? { x: Math.floor(view.x + p.x / view.zoom), y: Math.floor(view.y + p.y / view.zoom) } : null)

  const addToStroke = (tiles: Tile[]) => {
    const s = stroke.current
    if (!s || !paint) return
    for (const t of tiles) {
      for (const b of brushTiles(t.x, t.y, paint.brush)) {
        if (b.x >= 0 && b.y >= 0 && b.x < world.width && b.y < world.height) s.tiles.set(`${b.x},${b.y}`, b)
      }
    }
    setStrokeTiles([...s.tiles.values()])
  }

  const cancelStroke = () => {
    stroke.current = null
    setStrokeTiles([])
  }

  const onPointerDown = (e: React.PointerEvent) => {
    frame.current?.setPointerCapture(e.pointerId)
    const p = local(e)
    // Pennello: tasto sinistro o un dito solo. Un secondo dito annulla il tratto (è un pizzico)
    if (paint && e.button === 0 && pointers.current.size === 0) {
      const t = tileAt(p)
      if (t) {
        stroke.current = { pointer: e.pointerId, last: t, tiles: new Map() }
        addToStroke([t])
      }
    } else if (stroke.current) {
      cancelStroke()
    }
    pointers.current.set(e.pointerId, p)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const p = local(e)
    if (view) setHover({ x: Math.floor(view.x + p.x / view.zoom), y: Math.floor(view.y + p.y / view.zoom) })
    const previous = pointers.current.get(e.pointerId)
    if (!previous) return
    const all = [...pointers.current.entries()]
    pointers.current.set(e.pointerId, p)

    if (stroke.current?.pointer === e.pointerId) {
      const t = tileAt(p)
      if (t && (t.x !== stroke.current.last.x || t.y !== stroke.current.last.y)) {
        addToStroke(line(stroke.current.last, t))
        stroke.current.last = t
      }
      return
    }

    if (all.length === 1) {
      // Trascinamento
      const dx = p.x - previous.x
      const dy = p.y - previous.y
      setView((v) => (v ? clamp({ ...v, x: v.x - dx / v.zoom, y: v.y - dy / v.zoom }) : v))
    } else if (all.length === 2) {
      // Pizzico: zoom sul punto medio, più lo spostamento del punto medio
      const other = all.find(([id]) => id !== e.pointerId)![1]
      const before = Math.hypot(previous.x - other.x, previous.y - other.y)
      const after = Math.hypot(p.x - other.x, p.y - other.y)
      if (before > 0) zoomAt(after / before, (p.x + other.x) / 2, (p.y + other.y) / 2)
      setView((v) => (v ? clamp({ ...v, x: v.x - (p.x - previous.x) / 2 / v.zoom, y: v.y - (p.y - previous.y) / 2 / v.zoom }) : v))
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (stroke.current?.pointer === e.pointerId) {
      const tiles = [...stroke.current.tiles.values()]
      cancelStroke()
      if (e.type === 'pointerup' && tiles.length) paint?.onStroke(tiles)
    }
  }

  const toggleFullscreen = () => {
    const wrapper = frame.current?.parentElement
    if (!wrapper) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void wrapper.requestFullscreen?.()
  }

  const v = view
  // Riquadri: solo quando la panoramica sarebbe sgranata (o non c'è ancora), e solo quelli visibili
  const useChunks = v !== null && (overview.version === 0 || v.zoom >= 2 / overview.scale)
  const visible: { cx: number; cy: number; version: number }[] = []
  if (v && useChunks) {
    const cx0 = Math.max(0, Math.floor(v.x / cw))
    const cy0 = Math.max(0, Math.floor(v.y / ch))
    const cx1 = Math.min(cols - 1, Math.floor((v.x + size.w / v.zoom) / cw))
    const cy1 = Math.min(rows - 1, Math.floor((v.y + size.h / v.zoom) / ch))
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const version = manifest.chunks[cy * cols + cx] ?? 0
        if (version > 0) visible.push({ cx, cy, version })
      }
    }
  }

  const sprites = v !== null && (manifest.tileData ?? 0) > 0 && typesVersion !== null && v.zoom >= SPRITE_ZOOM

  const screen = (tx: number, ty: number) => (v ? { left: (tx - v.x) * v.zoom, top: (ty - v.y) * v.zoom } : { left: 0, top: 0 })

  return (
    <div className={fullscreen ? 'world-map world-map-fullscreen' : 'world-map'}>
      <div
        ref={frame}
        className={paint ? 'world-map-frame world-map-painting' : 'world-map-frame'}
        onContextMenu={(e) => paint && e.preventDefault()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={(e) => {
          if (paint) return
          const p = local(e as unknown as React.PointerEvent)
          zoomAt(2, p.x, p.y)
        }}
      >
        {v && (
          <div
            className="world-map-layer"
            style={{ width: world.width, height: world.height, transform: `translate(${-v.x * v.zoom}px, ${-v.y * v.zoom}px) scale(${v.zoom})` }}
          >
            {overview.version > 0 && (
              <img className="world-map-overview" src={overviewUrl(serverId, source, overview.version)} alt="" draggable={false} style={{ width: world.width, height: world.height }} />
            )}
            {visible.map(({ cx, cy, version }) => (
              <img
                key={`${cx}_${cy}`}
                className="world-map-chunk"
                src={chunkUrl(serverId, source, cx, cy, version)}
                alt=""
                draggable={false}
                style={{ left: cx * cw, top: cy * ch }}
              />
            ))}
          </div>
        )}

        {sprites && v && typesVersion !== null && (
          // Tipi nuovi (server riavviato): si ricomincia da capo, anche con gli sprite
          <SpriteLayer
            key={`${source}:${typesVersion}:${vanillaSprites}`}
            serverId={serverId}
            source={source}
            manifest={manifest}
            view={v}
            size={size}
            typesVersion={typesVersion}
            vanilla={vanillaSprites}
            visible={visible}
          />
        )}

        {v && (marks.length > 0 || strokeTiles.length > 0 || (paint && hover)) && (
          // Tile modificate (in attesa del ridisegno), tratto in corso e pennello sotto il cursore
          <div
            className="world-map-layer world-map-marks"
            style={{ transform: `translate(${-v.x * v.zoom}px, ${-v.y * v.zoom}px) scale(${v.zoom})`, '--zoom': v.zoom } as React.CSSProperties}
          >
            {marks.map((m) => (
              <span key={`m${m.x},${m.y}`} className={m.erase ? 'world-map-mark world-map-mark-erase' : 'world-map-mark'} style={{ left: m.x, top: m.y }} />
            ))}
            {strokeTiles.map((t) => (
              <span key={`s${t.x},${t.y}`} className={paint?.erase ? 'world-map-mark world-map-mark-erase' : 'world-map-mark'} style={{ left: t.x, top: t.y }} />
            ))}
            {paint && hover && strokeTiles.length === 0 && (
              <span
                className="world-map-brush"
                style={{ left: hover.x - Math.floor((paint.brush - 1) / 2), top: hover.y - Math.floor((paint.brush - 1) / 2), width: paint.brush, height: paint.brush }}
              />
            )}
          </div>
        )}

        {v && (
          <>
            <span className="world-map-spawn" style={screen(world.spawnX, world.spawnY)} title="Spawn">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 2l3 7h7l-5.5 4.5 2 7.5-6.5-4.5L5.5 21l2-7.5L2 9h7z" />
              </svg>
            </span>
            {players.map((p) => (
              <span
                key={p.name}
                className={p.dead ? 'world-map-player world-map-player-dead' : 'world-map-player'}
                style={{ ...screen(p.x, p.y), '--team': TEAM_COLOR[p.team] ?? TEAM_COLOR[0] } as React.CSSProperties}
                title={`${p.name} · ${t('{life}/{max} life', { life: p.life, max: p.lifeMax })}${p.dead ? ` · ${t('dead')}` : ''}`}
              >
                <span className="world-map-player-dot" />
                <span className="world-map-player-name">{p.name}</span>
              </span>
            ))}
          </>
        )}
      </div>

      <div className="world-map-controls">
        <button type="button" className="btn btn-sm btn-icon" aria-label={t('Zoom in')} title={t('Zoom in')} onClick={() => zoomAt(1.6, size.w / 2, size.h / 2)}>
          +
        </button>
        <button type="button" className="btn btn-sm btn-icon" aria-label={t('Zoom out')} title={t('Zoom out')} onClick={() => zoomAt(1 / 1.6, size.w / 2, size.h / 2)}>
          −
        </button>
        <button type="button" className="btn btn-sm" title={t('The whole world')} onClick={fit}>
          {t('Whole world')}
        </button>
        <button type="button" className="btn btn-sm" title={t('Center on the spawn')} onClick={() => centerOn(world.spawnX, world.spawnY, Math.max(v?.zoom ?? 2, 2))}>
          Spawn
        </button>
        <button type="button" className="btn btn-sm btn-icon" aria-label={fullscreen ? t('Exit full screen') : t('Full screen')} title={t('Full screen')} onClick={toggleFullscreen}>
          <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
            {fullscreen ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
          </svg>
        </button>
      </div>

      {hover && hover.x >= 0 && hover.y >= 0 && hover.x < world.width && hover.y < world.height && (
        <div className="world-map-coords mono">
          {hover.x}, {hover.y} · {layerOf(world, hover.y)}
        </div>
      )}
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { errorMessage } from '../../lib/api'
import type { WorldEditOp, WorldEditResult, WorldMapManifest } from '../../lib/types'
import { useChangeWorldSettings, useWorldEdit, useWorldEditorCatalog, useWorldUndo } from '../../lib/worldEditor'
import type { MapMark, MapPaint } from './MapViewer'
import TypePicker from './TypePicker'
import { t } from '../../i18n'

type Tool = 'move' | 'tile' | 'wall' | 'kill-tile' | 'kill-wall' | 'spawn'

const tools = (): { id: Tool; label: string; title: string }[] => [
  { id: 'move', label: t('Move'), title: t('Drag to move the map') },
  { id: 'tile', label: t('Block'), title: t('Places the chosen block (replaces normal blocks)') },
  { id: 'wall', label: t('Wall'), title: t('Places the chosen wall') },
  { id: 'kill-tile', label: t('Remove blocks'), title: t('Removes blocks and objects (full chests stay)') },
  { id: 'kill-wall', label: t('Remove walls'), title: t('Removes walls') },
  { id: 'spawn', label: 'Spawn', title: t('Click on the map: players without a bed respawn there') },
]

/** Dopo quanto le tile segnate spariscono comunque, se la mappa non le ridisegna. */
const MARK_TIMEOUT_MS = 20_000

type PendingMarks = { marks: MapMark[]; chunks: Map<number, number>; at: number }

/** Quanti tratti si possono annullare (la mod ne ricorda 50 comandi). */
const UNDO_STEPS = 30

/** Il fuoco è in un campo di testo: lì Ctrl+Z annulla il testo, non il mondo. */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

/**
 * Editor del mondo a server acceso (mod LiveMap): strumenti sopra la mappa, pennello sulla mappa. Le modifiche le fa
 * la mod sul server come un giocatore (chi è connesso le vede subito); la mappa le ridisegna dopo qualche secondo,
 * intanto le tile toccate restano segnate.
 */
export function useWorldEditor(serverId: string, manifest: WorldMapManifest | null, enabled: boolean) {
  const [tool, setTool] = useState<Tool>('move')
  const [brush, setBrush] = useState(1)
  const [tileType, setTileType] = useState(1) // pietra
  const [wallType, setWallType] = useState(1) // muro di pietra
  const [pending, setPending] = useState<PendingMarks[]>([])
  const [last, setLast] = useState<{ result: WorldEditResult; undo: boolean } | null>(null)
  /** Tratti annullabili, dal più vecchio: gli id dei loro pezzi. */
  const [history, setHistory] = useState<string[][]>([])
  const catalog = useWorldEditorCatalog(serverId, enabled)
  const edit = useWorldEdit(serverId)
  const settings = useChangeWorldSettings(serverId)
  const undo = useWorldUndo(serverId)

  const undoLast = () => {
    const step = history[history.length - 1]
    if (!step || undo.isPending || edit.isPending) return
    // Tolto subito: se non riesce (troppo vecchio, server riavviato) non si riprova
    setHistory((h) => h.slice(0, -1))
    undo.mutate(step, { onSuccess: (result) => setLast({ result, undo: true }) })
  }
  const undoRef = useRef(undoLast)
  useEffect(() => {
    undoRef.current = undoLast
  })

  // Ctrl+Z (Cmd+Z su Mac) annulla l'ultimo tratto, fuori dai campi di testo
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z' && !typing(e.target)) {
        e.preventDefault()
        undoRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])

  // Segni nascosti appena i riquadri toccati cambiano versione (ridisegnati), tolti comunque dopo un po'
  useEffect(() => {
    if (!pending.length) return
    const timer = setTimeout(() => setPending((list) => list.filter((p) => Date.now() - p.at < MARK_TIMEOUT_MS)), MARK_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [pending])

  const active = enabled && tool !== 'move'
  const erase = tool === 'kill-tile' || tool === 'kill-wall'

  const onStroke = (tiles: { x: number; y: number }[]) => {
    if (!manifest) return
    if (tool === 'spawn') {
      // Un clic: l'ultima tile toccata; poi si torna a spostare la mappa
      const at = tiles[tiles.length - 1]
      settings.mutate({ spawn: at })
      setTool('move')
      return
    }
    const ops: WorldEditOp[] = tiles.map(({ x, y }) => {
      switch (tool) {
        case 'tile':
          return { op: 'place-tile', x, y, type: tileType }
        case 'wall':
          return { op: 'place-wall', x, y, type: wallType }
        case 'kill-wall':
          return { op: 'kill-wall', x, y }
        default:
          return { op: 'kill-tile', x, y }
      }
    })
    const touched = new Map<number, number>()
    for (const { x, y } of tiles) {
      const i = Math.floor(y / manifest.chunkHeight) * manifest.cols + Math.floor(x / manifest.chunkWidth)
      touched.set(i, manifest.chunks[i] ?? 0)
    }
    const entry: PendingMarks = { marks: tiles.map((t) => ({ ...t, erase })), chunks: touched, at: Date.now() }
    setPending((list) => [...list, entry])
    edit.mutate(ops, {
      onSuccess: (outcome) => {
        setLast({ result: outcome, undo: false })
        if (outcome.undoIds.length) setHistory((h) => [...h, outcome.undoIds].slice(-UNDO_STEPS))
      },
      // Non applicata: niente segni
      onError: () => setPending((list) => list.filter((p) => p !== entry)),
    })
  }

  const paint: MapPaint | null = active ? { brush: tool === 'spawn' ? 1 : brush, erase, onStroke } : null
  const chunks = manifest?.chunks
  const marks = useMemo(
    () => pending.filter((p) => [...p.chunks].every(([i, v]) => (chunks?.[i] ?? 0) === v)).flatMap((p) => p.marks),
    [pending, chunks],
  )

  const toolbar = enabled ? (
    <div className="world-editor">
      <div className="segmented" role="group" aria-label={t('Tool')}>
        {tools().map((tl) => (
          <button key={tl.id} type="button" className={tool === tl.id ? 'active' : ''} title={tl.title} onClick={() => setTool(tl.id)}>
            {tl.label}
          </button>
        ))}
      </div>
      {(tool === 'tile' || tool === 'wall') && (
        <TypePicker
          key={tool}
          entries={(tool === 'tile' ? catalog.data?.tiles : catalog.data?.walls) ?? []}
          value={tool === 'tile' ? tileType : wallType}
          onChange={tool === 'tile' ? setTileType : setWallType}
          kind={tool === 'tile' ? t('Block') : t('Wall')}
        />
      )}
      <button
        type="button"
        className="btn btn-sm"
        disabled={!history.length || undo.isPending || edit.isPending}
        title={t('Undo the last stroke (Ctrl+Z): tiles changed since by someone else stay as they are')}
        onClick={undoLast}
      >
        {t('Undo')}
      </button>
      {active && tool !== 'spawn' && (
        <select value={brush} onChange={(e) => setBrush(Number(e.target.value))} aria-label={t('Brush')} title={t('Brush size')}>
          {[1, 2, 3, 5, 9].map((n) => (
            <option key={n} value={n}>
              {n}×{n}
            </option>
          ))}
        </select>
      )}
      <span className="small muted">
        {tool === 'spawn'
          ? t('Click on the map where to put the spawn.')
          : settings.isPending
            ? t('Moving the spawn…')
            : settings.error
              ? <span className="error-text">{errorMessage(settings.error)}</span>
              : settings.data?.failed
                ? <span className="error-text">{t('Spawn not moved: {reason}', { reason: settings.data.failures[0]?.reason ?? '' })}</span>
                : edit.isPending || undo.isPending
          ? t('Sending…')
          : edit.error || undo.error
            ? <span className="error-text">{errorMessage(edit.error ?? undo.error)}</span>
            : last
              ? `${t(last.undo ? '{count} tiles restored' : '{count} tiles changed', { count: last.result.applied })}${last.result.failed ? ` · ${t('{count} not', { count: last.result.failed })} (${[...new Set(last.result.failures.map((f) => f.reason))].join(', ')})` : ''}`
              : active
                ? t('Left button to draw, right button to move the map.')
                : ''}
      </span>
      {catalog.error ? <span className="small error-text">{errorMessage(catalog.error)}</span> : null}
    </div>
  ) : null

  return { toolbar, paint, marks, pickSpawn: () => setTool('spawn') }
}

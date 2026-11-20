import { useEffect, useMemo, useState } from 'react'
import { errorMessage } from '../../lib/api'
import type { WorldEditOp, WorldEditResult, WorldMapManifest } from '../../lib/types'
import { useWorldEdit, useWorldEditorCatalog } from '../../lib/worldEditor'
import type { MapMark, MapPaint } from './MapViewer'
import TypePicker from './TypePicker'

type Tool = 'move' | 'tile' | 'wall' | 'kill-tile' | 'kill-wall'

const TOOLS: { id: Tool; label: string; title: string }[] = [
  { id: 'move', label: 'Sposta', title: 'Trascina per spostare la mappa' },
  { id: 'tile', label: 'Blocco', title: 'Piazza il blocco scelto (sostituisce i blocchi normali)' },
  { id: 'wall', label: 'Muro', title: 'Piazza il muro scelto' },
  { id: 'kill-tile', label: 'Togli blocchi', title: 'Rimuove blocchi e oggetti (le casse piene restano)' },
  { id: 'kill-wall', label: 'Togli muri', title: 'Rimuove i muri' },
]

/** Dopo quanto le tile segnate spariscono comunque, se la mappa non le ridisegna. */
const MARK_TIMEOUT_MS = 20_000

type PendingMarks = { marks: MapMark[]; chunks: Map<number, number>; at: number }

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
  const [last, setLast] = useState<WorldEditResult | null>(null)
  const catalog = useWorldEditorCatalog(serverId, enabled)
  const edit = useWorldEdit(serverId)

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
      onSuccess: setLast,
      // Non applicata: niente segni
      onError: () => setPending((list) => list.filter((p) => p !== entry)),
    })
  }

  const paint: MapPaint | null = active ? { brush, erase, onStroke } : null
  const chunks = manifest?.chunks
  const marks = useMemo(
    () => pending.filter((p) => [...p.chunks].every(([i, v]) => (chunks?.[i] ?? 0) === v)).flatMap((p) => p.marks),
    [pending, chunks],
  )

  const toolbar = enabled ? (
    <div className="world-editor">
      <div className="segmented" role="group" aria-label="Strumento">
        {TOOLS.map((t) => (
          <button key={t.id} type="button" className={tool === t.id ? 'active' : ''} title={t.title} onClick={() => setTool(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {(tool === 'tile' || tool === 'wall') && (
        <TypePicker
          key={tool}
          entries={(tool === 'tile' ? catalog.data?.tiles : catalog.data?.walls) ?? []}
          value={tool === 'tile' ? tileType : wallType}
          onChange={tool === 'tile' ? setTileType : setWallType}
          kind={tool === 'tile' ? 'Blocco' : 'Muro'}
        />
      )}
      {active && (
        <select value={brush} onChange={(e) => setBrush(Number(e.target.value))} aria-label="Pennello" title="Dimensione del pennello">
          {[1, 2, 3, 5, 9].map((n) => (
            <option key={n} value={n}>
              {n}×{n}
            </option>
          ))}
        </select>
      )}
      <span className="small muted">
        {edit.isPending
          ? 'Invio…'
          : edit.error
            ? <span className="error-text">{errorMessage(edit.error)}</span>
            : last
              ? `${last.applied} tile modificate${last.failed ? ` · ${last.failed} no (${[...new Set(last.failures.map((f) => f.reason))].join(', ')})` : ''}`
              : active
                ? 'Tasto sinistro per disegnare, destro per spostare la mappa.'
                : ''}
      </span>
      {catalog.error ? <span className="small error-text">{errorMessage(catalog.error)}</span> : null}
    </div>
  ) : null

  return { toolbar, paint, marks }
}

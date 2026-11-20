import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { t } from '../i18n'

export type OverflowAction = {
  key: string
  /** Il pulsante com'è nella riga. */
  inline: ReactNode
  /** La stessa azione come voce del menu «⋯». */
  label: string
  icon?: ReactNode
  onSelect: () => void
  disabled?: boolean
  danger?: boolean
  /** Più è alta, più a lungo il pulsante resta nella riga (i primi a finire nel menu sono i più bassi). */
  priority: number
  /** Allineato a destra, dopo lo spazio libero. */
  end?: boolean
  /** Le azioni con lo stesso gruppo finiscono nel menu tutte insieme. */
  group?: string
  /** Con `end`: resta a destra del pulsante «⋯» quando il menu c'è. */
  afterMenu?: boolean
}

const MENU_BUTTON = 36

/**
 * Riga di pulsanti in fondo a una card. Se non ci stanno tutti, quelli meno importanti finiscono
 * in un menu che si apre dal pulsante «⋯» a destra. La riga non va mai a capo: l'altezza resta quella
 * di un pulsante.
 */
export default function OverflowActions({ actions, menuLabel }: { actions: OverflowAction[]; menuLabel: string }) {
  const rowRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [rowWidth, setRowWidth] = useState(0)
  const [widths, setWidths] = useState<Record<string, number>>({})
  const [gap, setGap] = useState(6)
  const [open, setOpen] = useState(false)

  // Larghezza della riga e di ogni pulsante (misurati in una copia invisibile, tutti affiancati)
  useLayoutEffect(() => {
    const row = rowRef.current
    const measure = measureRef.current
    if (!row || !measure) return
    const update = () => {
      setRowWidth(row.clientWidth)
      setGap(parseFloat(getComputedStyle(row).columnGap) || 6)
      const next: Record<string, number> = {}
      for (const child of measure.children) {
        const key = (child as HTMLElement).dataset.key
        if (key) next[key] = (child as HTMLElement).getBoundingClientRect().width
      }
      setWidths((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(row)
    observer.observe(measure)
    return () => observer.disconnect()
  }, [])

  const hidden = useMemo(() => {
    if (!rowWidth) return new Set<string>()
    const fits = (shown: OverflowAction[], withMenu: boolean) => {
      const items = shown.length + (withMenu ? 1 : 0)
      const total = shown.reduce((sum, a) => sum + (widths[a.key] ?? 0), 0) + (withMenu ? MENU_BUTTON : 0)
      // +1 gap per lo spazio libero tra i pulsanti a sinistra e quelli a destra
      return total + gap * items <= rowWidth
    }
    if (fits(actions, false)) return new Set<string>()
    const out = new Set<string>()
    for (const action of [...actions].sort((a, b) => a.priority - b.priority)) {
      if (out.has(action.key)) continue
      for (const a of actions) if (a.key === action.key || (action.group && a.group === action.group)) out.add(a.key)
      if (fits(actions.filter((a) => !out.has(a.key)), true)) break
    }
    return out
  }, [actions, widths, rowWidth, gap])

  // Il menu si chiude cliccando fuori o con Esc
  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    // Da tastiera si parte dalla prima voce del menu
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const visible = actions.filter((a) => !hidden.has(a.key))
  const overflow = actions.filter((a) => hidden.has(a.key))
  const start = visible.filter((a) => !a.end)
  const end = visible.filter((a) => a.end && !(overflow.length > 0 && a.afterMenu))
  const afterMenu = overflow.length > 0 ? visible.filter((a) => a.end && a.afterMenu) : []

  return (
    // I clic nella riga non arrivano alla card (che altrimenti si aprirebbe)
    <div className="mod-card-actions overflow-actions" ref={rowRef} onClick={(e) => e.stopPropagation()}>
      {start.map((a) => (
        <span key={a.key} className="overflow-item">
          {a.inline}
        </span>
      ))}
      <span className="spacer" />
      {end.map((a) => (
        <span key={a.key} className="overflow-item">
          {a.inline}
        </span>
      ))}

      {overflow.length > 0 && (
        <div className="overflow-menu-anchor" ref={menuRef}>
          <button
            type="button"
            className="btn btn-sm btn-icon"
            aria-label={menuLabel}
            title={t('More actions')}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <svg className="ic ic-fill" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3" />
            </svg>
          </button>
          {open && (
            <div className="overflow-menu" role="menu">
              {overflow.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  role="menuitem"
                  className={a.danger ? 'overflow-menu-item overflow-menu-danger' : 'overflow-menu-item'}
                  disabled={a.disabled}
                  onClick={() => {
                    setOpen(false)
                    a.onSelect()
                  }}
                >
                  {a.icon}
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {afterMenu.map((a) => (
        <span key={a.key} className="overflow-item">
          {a.inline}
        </span>
      ))}

      {/* Copia invisibile di tutti i pulsanti, solo per misurarli */}
      <div className="overflow-measure" ref={measureRef} aria-hidden="true" inert>
        {actions.map((a) => (
          <span key={a.key} data-key={a.key} className="overflow-item">
            {a.inline}
          </span>
        ))}
      </div>
    </div>
  )
}

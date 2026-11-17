import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react'

/** Larghezza sotto cui la finestra diventa una bottom sheet (la stessa dei layout stretti). */
const MOBILE = '(max-width: 599px)'
/** Durata dell'animazione di chiusura (la stessa del CSS). */
const CLOSE_MS = 180
/** Trascinando giù la sheet: oltre questa distanza (px) o velocità (px/ms) si chiude. */
const CLOSE_DISTANCE = 110
const CLOSE_VELOCITY = 0.6

/**
 * Finestra che su schermi stretti è una bottom sheet (sale dal basso, si chiude trascinandola giù
 * dalla maniglia o dal titolo) e su schermi larghi una modale centrata.
 *
 * Usa l'elemento <dialog> nativo: focus, Esc e sfondo li gestisce il browser. Il contenuto è montato
 * solo mentre è aperta, quindi a ogni apertura riparte da zero (form compresi).
 */
export default function Sheet({ open, title, onClose, children }: { open: boolean; title: ReactNode; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ startY: number; y: number; t: number; velocity: number } | null>(null)
  // In chiusura: `open` è già false ma la finestra resta visibile per l'animazione di uscita
  const [closing, setClosing] = useState(false)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    setClosing(!open)
  }

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (closing) {
      const timer = setTimeout(() => {
        dialog.close()
        setClosing(false)
        if (panelRef.current) panelRef.current.style.transform = ''
      }, CLOSE_MS)
      return () => clearTimeout(timer)
    }
  }, [open, closing])

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (!window.matchMedia(MOBILE).matches || (e.target as HTMLElement).closest('button, a, input, select, textarea')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { startY: e.clientY, y: e.clientY, t: e.timeStamp, velocity: 0 }
    panelRef.current?.classList.add('sheet-dragging')
  }

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d) return
    const dt = e.timeStamp - d.t
    if (dt > 0) d.velocity = (e.clientY - d.y) / dt
    d.y = e.clientY
    d.t = e.timeStamp
    // Verso l'alto non si sposta: la sheet è già alta quanto il suo contenuto
    if (panelRef.current) panelRef.current.style.transform = `translateY(${Math.max(0, e.clientY - d.startY)}px)`
  }

  const onPointerUp = () => {
    const d = drag.current
    if (!d) return
    drag.current = null
    const panel = panelRef.current
    panel?.classList.remove('sheet-dragging')
    if (d.y - d.startY > CLOSE_DISTANCE || d.velocity > CLOSE_VELOCITY) onClose()
    else if (panel) panel.style.transform = '' // torna su (con la transizione del CSS)
  }

  return (
    <dialog
      ref={ref}
      className={closing ? 'dialog sheet sheet-closing' : 'dialog sheet'}
      // Esc: si chiude passando dal genitore, così parte l'animazione
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      // Un clic sullo sfondo (fuori dal riquadro) chiude la finestra
      onClick={(e) => e.target === ref.current && onClose()}
    >
      <div className="dialog-panel sheet-panel" ref={panelRef}>
        <header className="dialog-header sheet-header" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <span className="sheet-handle" aria-hidden="true" />
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Chiudi" onClick={onClose}>
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>
        <div className="dialog-body sheet-body">{(open || closing) && children}</div>
      </div>
    </dialog>
  )
}

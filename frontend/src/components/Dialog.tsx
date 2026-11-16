import { type ReactNode, useEffect, useRef } from 'react'

/**
 * Finestra modale (elemento <dialog> nativo: focus, Esc e sfondo li gestisce il browser).
 * Il contenuto resta montato anche da chiusa, così un caricamento in corso non si interrompe.
 */
export default function Dialog({
  open,
  title,
  onClose,
  wide = false,
  children,
}: {
  open: boolean
  title: ReactNode
  onClose: () => void
  wide?: boolean
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className={wide ? 'dialog dialog-wide' : 'dialog'}
      onClose={onClose}
      // Un clic sullo sfondo (fuori dal riquadro) chiude la finestra
      onClick={(e) => e.target === ref.current && onClose()}
    >
      <div className="dialog-panel">
        <header className="dialog-header">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Chiudi" onClick={onClose}>
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>
        <div className="dialog-body">{children}</div>
      </div>
    </dialog>
  )
}

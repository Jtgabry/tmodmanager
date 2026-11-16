import { type ReactNode, useContext } from 'react'
import { createPortal } from 'react-dom'
import { PageActionsSlot } from '../lib/pageActions'

/** Contenuto mostrato accanto al titolo della pagina del server (riepilogo, pulsanti). */
export default function PageActions({ children }: { children: ReactNode }) {
  const slot = useContext(PageActionsSlot)
  return slot ? createPortal(children, slot) : null
}

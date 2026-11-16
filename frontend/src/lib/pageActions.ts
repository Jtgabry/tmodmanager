import { createContext } from 'react'

/** Spazio accanto al titolo della pagina, dove le pagine di un server mettono i propri pulsanti (vedi PageActions). */
export const PageActionsSlot = createContext<HTMLElement | null>(null)

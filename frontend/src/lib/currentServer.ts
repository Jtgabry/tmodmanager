import { useOutletContext } from 'react-router-dom'
import type { Server } from './types'

/** Server della pagina di dettaglio, passato alle schede tramite <Outlet context>. */
export function useCurrentServer() {
  return useOutletContext<Server>()
}

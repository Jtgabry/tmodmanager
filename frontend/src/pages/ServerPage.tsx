import { useState } from 'react'
import { Outlet, useLocation, useParams } from 'react-router-dom'
import ServerStats from '../components/ServerStats'
import { errorMessage } from '../lib/api'
import { formatDate } from '../lib/format'
import { useServer } from '../lib/servers'
import { useCurrentServer } from '../lib/currentServer'
import { PageActionsSlot } from '../lib/pageActions'

const TITLES: Record<string, string> = {
  console: 'Console',
  mods: 'Mod',
  workshop: 'Workshop',
  modpacks: 'Modpack',
  files: 'File',
  trash: 'Cestino',
}

/**
 * Contenitore delle pagine di un server. Nome, stato e pulsanti di accensione
 * stanno nella sidebar (vedi Layout); qui solo titolo della pagina e avvisi.
 */
export default function ServerPage() {
  const { serverId = '' } = useParams()
  const { pathname } = useLocation()
  const { data: server, isLoading, error } = useServer(serverId)
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null)

  if (isLoading) return <div className="spinner" />
  if (error || !server) return <div className="alert alert-error">{errorMessage(error)}</div>

  const section = pathname.split('/')[3] ?? ''
  const title = TITLES[section] ?? 'Panoramica'

  return (
    <section className="stack">
      <div className="page-header">
        <h1>{title}</h1>
        <div className="page-actions" ref={setActionsSlot} />
      </div>

      {server.lastError && (
        <div className="alert alert-error">
          Ultima operazione fallita: {server.lastError.message}{' '}
          <span className="muted">({formatDate(server.lastError.at)})</span>
        </div>
      )}

      {server.restartRequired && (
        <div className="alert alert-warning">
          Le mod sono cambiate dopo l'avvio: riavvia il server per applicare le modifiche.
        </div>
      )}

      {/* key: cambiando server le pagine ripartono da zero (console compresa) */}
      <PageActionsSlot.Provider value={actionsSlot}>
        <div key={server.id}>
          <Outlet context={server} />
        </div>
      </PageActionsSlot.Provider>
    </section>
  )
}

export function ServerOverview() {
  const server = useCurrentServer()
  return <ServerStats server={server} tiles />
}

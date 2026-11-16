import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import PowerButtons from '../components/PowerButtons'
import ServerStats from '../components/ServerStats'
import StateBadge from '../components/StateBadge'
import { errorMessage } from '../lib/api'
import { formatDate } from '../lib/format'
import { useServers } from '../lib/servers'

export default function ServersPage() {
  const { can, user } = useAuth()
  const { data: servers, isLoading, error } = useServers()

  return (
    <section>
      <div className="page-header">
        <h1>Server</h1>
      </div>

      {isLoading && <div className="spinner" />}
      {error && <div className="alert alert-error">{errorMessage(error)}</div>}
      {servers?.length === 0 && (
        <div className="empty">
          {user?.isAdmin
            ? 'Nessun server registrato. Aggiungilo in agent/data/servers.json.'
            : 'Non hai accesso a nessun server. Chiedi a un amministratore.'}
        </div>
      )}

      <div className="server-grid">
        {servers?.map((server) => (
          <article key={server.id} className="card server-card">
            <header className="server-card-header">
              <Link to={`/servers/${server.id}`} className="server-name">
                {server.name}
              </Link>
              <StateBadge state={server.state} />
            </header>
            <ServerStats server={server} />
            {server.lastError && (
              <div className="alert alert-error">
                {server.lastError.message} <span className="muted">({formatDate(server.lastError.at)})</span>
              </div>
            )}
            <footer className="server-card-footer">
              {can(server.id, 'power') ? <PowerButtons server={server} /> : <span />}
              <Link to={`/servers/${server.id}`} className="btn btn-ghost">
                Apri →
              </Link>
            </footer>
          </article>
        ))}
      </div>
    </section>
  )
}

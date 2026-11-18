import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext'
import PageActions from '../../components/PageActions'
import { errorMessage } from '../../lib/api'
import { useCurrentServer } from '../../lib/currentServer'
import { formatDate } from '../../lib/format'
import { useTogglePlugin } from '../../lib/plugins'
import { GAME_LABEL, type Server, type WorldMapState } from '../../lib/types'
import { useWorldMap, worldMapKey } from '../../lib/worldMap'
import MapViewer from './MapViewer'

/**
 * Sezione "Mondo": mappa del mondo del server. Oggi la disegna l'add-on LiveMap sui server TShock;
 * per gli altri server arriverà la lettura del file del mondo (.wld / .twld), con la stessa mappa.
 */
export default function WorldTab() {
  const server = useCurrentServer()
  const map = useWorldMap(server.id)
  const [focus, setFocus] = useState<{ name: string; at: number } | null>(null)

  if (map.isLoading) return <div className="spinner" />
  if (map.error) return <div className="alert alert-error">{errorMessage(map.error)}</div>
  const state = map.data
  if (!state) return null
  if (!state.manifest) return <Unavailable server={server} state={state} />

  const { manifest, players } = state
  const { world, progress } = manifest
  const drawing = progress.drawn < progress.total

  return (
    <div className="stack">
      <PageActions>
        <span className="muted page-summary">
          {world.name} · {world.width}×{world.height}
        </span>
      </PageActions>

      {!state.liveMap?.enabled ? (
        <div className="alert alert-warning">LiveMap è disattivato: questa è l'ultima mappa disegnata, non si aggiorna più.</div>
      ) : server.state !== 'running' ? (
        <div className="alert alert-info">Server spento: la mappa è quella dell'ultima volta che era acceso.</div>
      ) : drawing ? (
        <div className="world-map-progress">
          <span className="small">
            LiveMap sta disegnando il mondo: {progress.drawn} riquadri su {progress.total}. Con la mappa aperta va avanti senza pesare
            sul server.
          </span>
          <div className="progress">
            <div style={{ width: `${Math.round((progress.drawn / Math.max(1, progress.total)) * 100)}%` }} />
          </div>
        </div>
      ) : null}

      <MapViewer serverId={server.id} manifest={manifest} players={players} focus={focus} />

      <div className="world-map-footer">
        <div className="world-map-players">
          {players.length === 0 ? (
            <span className="muted small">Nessun giocatore nel mondo.</span>
          ) : (
            players.map((p) => (
              <button key={p.name} type="button" className="tag-filter" onClick={() => setFocus({ name: p.name, at: Date.now() })} title="Centra la mappa sul giocatore">
                {p.name} · {p.dead ? 'morto' : `${p.life}/${p.lifeMax}`}
              </button>
            ))
          )}
        </div>
        <span className="muted small">
          LiveMap{state.updatedAt ? ` · aggiornata ${formatDate(state.updatedAt)}` : ''}
        </span>
      </div>
    </div>
  )
}

/** Niente mappa da mostrare: perché, e cosa fare. */
function Unavailable({ server, state }: { server: Server; state: WorldMapState }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const toggle = useTogglePlugin(server.id)
  const canManage = can(server.id, 'mods')

  switch (state.unavailable) {
    case 'unsupported-game':
      return (
        <div className="empty">
          <p>
            La mappa dei server {GAME_LABEL[server.game]} arriverà leggendo direttamente il file del mondo
            {server.game === 'tmodloader' ? ' (.wld e .twld)' : ' (.wld)'}.
          </p>
          <p className="small">Per ora la mappa in tempo reale c'è sui server TShock, con l'add-on LiveMap.</p>
        </div>
      )
    case 'addon-missing':
      return <div className="empty">L'add-on LiveMap non è presente in questa installazione del pannello.</div>
    case 'addon-disabled':
      return (
        <div className="empty stack-sm">
          <p>
            La mappa del mondo la disegna <strong>LiveMap</strong>, un add-on di tModManager per TShock. Lavora solo mentre qualcuno
            guarda questa pagina, e al massimo 1 ms per tick.
          </p>
          {canManage ? (
            <div className="stack-sm">
              <div>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={toggle.isPending}
                  onClick={() =>
                    toggle.mutate({ name: 'LiveMap', enabled: true }, { onSettled: () => queryClient.invalidateQueries({ queryKey: worldMapKey(server.id) }) })
                  }
                >
                  Attiva LiveMap
                </button>
              </div>
              <p className="small">
                Si può disattivare in qualsiasi momento da <Link to={`/servers/${server.id}/plugins`}>Plugin</Link>.
              </p>
              {toggle.error ? <div className="alert alert-error">{errorMessage(toggle.error)}</div> : null}
            </div>
          ) : (
            <p className="small">Chiedi a chi gestisce il server di attivarlo dalla sezione Plugin.</p>
          )}
        </div>
      )
    case 'no-data':
      return (
        <div className="empty stack-sm">
          {server.state === 'stopped' ? (
            <p>LiveMap è attivo: avvia il server e la mappa comparirà qui.</p>
          ) : server.restartRequired ? (
            <p>LiveMap è attivo, ma il server va riavviato per caricarlo.</p>
          ) : (
            <>
              <div className="spinner" />
              <p>LiveMap sta preparando la mappa…</p>
            </>
          )}
        </div>
      )
    default:
      return null
  }
}

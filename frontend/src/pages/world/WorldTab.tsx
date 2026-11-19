import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext'
import PageActions from '../../components/PageActions'
import { errorMessage } from '../../lib/api'
import { useCurrentServer } from '../../lib/currentServer'
import { formatDate } from '../../lib/format'
import { useToggleMod } from '../../lib/mods'
import { useTogglePlugin } from '../../lib/plugins'
import type { Server, WorldMapState } from '../../lib/types'
import { useWorldMap, worldMapKey } from '../../lib/worldMap'
import MapViewer from './MapViewer'

/**
 * Sezione "Mondo": mappa del mondo del server. Con l'add-on LiveMap (plugin sui server TShock, mod sui server
 * tModLoader) è in tempo reale, con i giocatori; altrimenti (e per Terraria vanilla) si ricava dal file del mondo
 * a ogni salvataggio.
 */
export default function WorldTab() {
  const server = useCurrentServer()
  const map = useWorldMap(server.id)
  const [focus, setFocus] = useState<{ name: string; at: number } | null>(null)

  if (map.isLoading) return <div className="spinner" />
  if (map.error) return <div className="alert alert-error">{errorMessage(map.error)}</div>
  const state = map.data
  if (!state) return null
  if (!state.manifest || !state.source) return <Unavailable state={state} />

  const { manifest, players, source } = state
  const { world, progress } = manifest
  const live = source === 'livemap'

  return (
    <div className="stack">
      <PageActions>
        <span className="muted page-summary">
          {world.name} · {world.width}×{world.height}
        </span>
      </PageActions>

      {live ? <LiveNotice server={server} state={state} /> : <WorldFileNotice server={server} state={state} />}

      <MapViewer serverId={server.id} source={source} manifest={manifest} players={players} focus={focus} />

      <div className="world-map-footer">
        {live ? (
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
        ) : (
          <span />
        )}
        <span className="muted small">
          {live ? 'LiveMap, in tempo reale' : 'Dal file del mondo'}
          {state.updatedAt ? ` · ${live ? 'aggiornata' : 'salvato'} ${formatDate(state.updatedAt)}` : ''}
          {!live && progress.drawn < progress.total ? ` · ${progress.drawn}/${progress.total}` : ''}
        </span>
      </div>
    </div>
  )
}

/** Mappa di LiveMap: server spento o primo disegno in corso. */
function LiveNotice({ server, state }: { server: Server; state: WorldMapState }) {
  const progress = state.manifest!.progress
  if (server.state !== 'running') return <div className="alert alert-info">Server spento: la mappa è quella dell'ultima volta che era acceso.</div>
  if (progress.drawn >= progress.total) return null
  return (
    <div className="world-map-progress">
      <span className="small">
        LiveMap sta disegnando il mondo: {progress.drawn} riquadri su {progress.total}. Con la mappa aperta va avanti senza pesare sul
        server.
      </span>
      <div className="progress">
        <div style={{ width: `${Math.round((progress.drawn / Math.max(1, progress.total)) * 100)}%` }} />
      </div>
    </div>
  )
}

/** Mappa dal file del mondo: da quando è, cosa manca, come averla in tempo reale. */
function WorldFileNotice({ server, state }: { server: Server; state: WorldMapState }) {
  const file = state.worldFile
  return (
    <div className="stack-sm">
      <p className="hint world-map-hint">
        Mappa ricavata dal file del mondo: si aggiorna a ogni salvataggio
        {server.state === 'running' ? ' (salvataggi automatici del gioco, o alla chiusura del server)' : ''}.
        {file?.generating && ' Sto leggendo il salvataggio più recente…'}
        {server.game === 'tmodloader' &&
          state.modBlocks &&
          !state.modBlocks.error &&
          ' I blocchi delle mod (dal file .twld) hanno il colore medio della loro texture: può differire un po\' da quello della mappa del gioco.'}
      </p>
      {state.modBlocks?.error && (
        <div className="alert alert-warning">I blocchi delle mod non si sono potuti leggere dal file .twld ({state.modBlocks.error}): la mappa mostra solo quelli di Terraria.</div>
      )}
      {file?.error && <div className="alert alert-warning">L'ultimo salvataggio non si è potuto leggere ({file.error}): la mappa è quella precedente.</div>}
      {state.liveMap?.enabled && (
        <div className="alert alert-info">
          LiveMap è attivo: la mappa in tempo reale, con i giocatori, compare quando il server lo carica (dopo il riavvio) e ha disegnato i
          primi riquadri.
        </div>
      )}
      {state.liveMap && !state.liveMap.enabled && state.liveMap.available && <ActivateLiveMap server={server} installed={state.liveMap.installed} />}
    </div>
  )
}

/**
 * Invito ad attivare LiveMap (solo a chi gestisce plugin e mod del server). TShock: è tra i plugin, si attiva da
 * qui. tModLoader: è una mod del Workshop del pannello; installata, si abilita da qui come le altre mod.
 */
function ActivateLiveMap({ server, installed }: { server: Server; installed: boolean }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const togglePlugin = useTogglePlugin(server.id)
  const toggleMod = useToggleMod(server.id)
  if (!can(server.id, 'mods')) return null
  const tml = server.game === 'tmodloader'
  const pending = togglePlugin.isPending || toggleMod.isPending
  const error = togglePlugin.error ?? toggleMod.error
  const refresh = { onSettled: () => queryClient.invalidateQueries({ queryKey: worldMapKey(server.id) }) }
  const activate = () =>
    tml ? toggleMod.mutate({ name: 'TmmLiveMap', enabled: true }, refresh) : togglePlugin.mutate({ name: 'LiveMap', enabled: true }, refresh)
  return (
    <div className="world-map-callout">
      <span className="small">
        Per vederla in tempo reale, con i giocatori, attiva <strong>LiveMap</strong>: lavora solo sul server, solo mentre questa pagina è
        aperta.{' '}
        {tml && !installed ? (
          <>
            La trovi nel <Link to={`/servers/${server.id}/workshop`}>Workshop</Link>.
          </>
        ) : (
          <>
            Si disattiva da <Link to={`/servers/${server.id}/${tml ? 'mods' : 'plugins'}`}>{tml ? 'Mod' : 'Plugin'}</Link>.
          </>
        )}
      </span>
      {tml && !installed ? (
        <Link className="btn btn-sm btn-primary" to={`/servers/${server.id}/workshop`}>
          Vai al Workshop
        </Link>
      ) : (
        <button type="button" className="btn btn-sm btn-primary" disabled={pending} onClick={activate}>
          Attiva LiveMap
        </button>
      )}
      {error ? <span className="error-text small">{errorMessage(error)}</span> : null}
    </div>
  )
}

/** Niente mappa da mostrare: perché, e cosa fare. */
function Unavailable({ state }: { state: WorldMapState }) {
  switch (state.unavailable) {
    case 'no-world':
      return <div className="empty">Il mondo non esiste ancora: verrà creato al primo avvio del server, e la mappa comparirà qui.</div>
    case 'no-colors':
      return (
        <div className="empty">
          Mancano i colori della mappa (<span className="mono">addons/dist/map-colors.json</span>): in un'installazione di sviluppo si creano
          con <span className="mono">addons/build.sh</span>.
        </div>
      )
    case 'world-error':
      return <div className="alert alert-error">Il file del mondo non si è potuto leggere: {state.worldFile?.error}</div>
    case 'loading':
      return (
        <div className="empty stack-sm">
          <div className="spinner" />
          <p>Sto leggendo il file del mondo…</p>
          {state.liveMap?.enabled && <p className="small">LiveMap è attivo: dopo, la mappa sarà in tempo reale.</p>}
        </div>
      )
    default:
      return null
  }
}

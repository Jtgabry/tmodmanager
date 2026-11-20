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
import { useWorldEditor } from './useWorldEditor'
import WorldSettingsCard from './WorldSettingsCard'
import { t, tn } from '../../i18n'

/**
 * Sezione "Mondo": mappa del mondo del server. Con l'add-on LiveMap (plugin sui server TShock, mod sui server
 * tModLoader) è in tempo reale, con i giocatori; altrimenti (e per Terraria vanilla) si ricava dal file del mondo
 * a ogni salvataggio.
 */
export default function WorldTab() {
  const server = useCurrentServer()
  const map = useWorldMap(server.id)
  const { can } = useAuth()
  const [focus, setFocus] = useState<{ name: string; at: number } | null>(null)
  const state = map.data
  // Editor: server acceso con la mod LiveMap che risponde, per chi ha la console (può già cambiare il mondo coi comandi)
  const editing = Boolean(state?.editor && state.source === 'livemap' && server.state === 'running' && can(server.id, 'console'))
  const editor = useWorldEditor(server.id, state?.manifest ?? null, editing)

  if (map.isLoading) return <div className="spinner" />
  if (map.error) return <div className="alert alert-error">{errorMessage(map.error)}</div>
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

      {editor.toolbar}

      <MapViewer
        serverId={server.id}
        source={source}
        manifest={manifest}
        players={players}
        focus={focus}
        typesVersion={state.typesVersion ?? null}
        vanillaSprites={state.vanillaSprites ?? null}
        paint={editor.paint}
        marks={editor.marks}
      />

      <div className="world-map-footer">
        {live ? (
          <div className="world-map-players">
            {players.length === 0 ? (
              <span className="muted small">{t('No players in the world.')}</span>
            ) : (
              players.map((p) => (
                <button key={p.name} type="button" className="tag-filter" onClick={() => setFocus({ name: p.name, at: Date.now() })} title={t('Center the map on the player')}>
                  {p.name} · {p.dead ? t('dead') : `${p.life}/${p.lifeMax}`}
                </button>
              ))
            )}
          </div>
        ) : (
          <span />
        )}
        <span className="muted small">
          {live ? t('LiveMap, live') : t('From the world file')}
          {state.updatedAt
            ? ` · ${live ? t('updated {date}', { date: formatDate(state.updatedAt) }) : t('saved {date}', { date: formatDate(state.updatedAt) })}`
            : ''}
          {!live && progress.drawn < progress.total ? ` · ${progress.drawn}/${progress.total}` : ''}
        </span>
      </div>

      {editing && <WorldSettingsCard serverId={server.id} onPickSpawn={editor.pickSpawn} />}
    </div>
  )
}

/** Mappa di LiveMap: server spento o primo disegno in corso. */
function LiveNotice({ server, state }: { server: Server; state: WorldMapState }) {
  const progress = state.manifest!.progress
  if (server.state !== 'running') return <div className="alert alert-info">{t('Server stopped: the map is from the last time it was running.')}</div>
  if (progress.drawn >= progress.total) return null
  return (
    <div className="world-map-progress">
      <span className="small">
        {t('LiveMap is drawing the world: {drawn} of {total} chunks. With the map open it keeps going without weighing on the server.', {
          drawn: progress.drawn,
          total: progress.total,
        })}
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
        {server.state === 'running'
          ? t('Map read from the world file: it is updated on every save (automatic game saves, or when the server shuts down).')
          : t('Map read from the world file: it is updated on every save.')}
        {file?.generating && ` ${t('Reading the latest save…')}`}
        {server.game === 'tmodloader' &&
          state.modBlocks &&
          !state.modBlocks.error &&
          ` ${t('Mod blocks (from the .twld file) have the average color of their texture: it may differ a bit from the in-game map.')}`}
      </p>
      {state.modBlocks?.error && (
        <div className="alert alert-warning">
          {t('Mod blocks could not be read from the .twld file ({error}): the map only shows the Terraria ones.', { error: state.modBlocks.error })}
        </div>
      )}
      {file?.error && <div className="alert alert-warning">{t('The latest save could not be read ({error}): the map is the previous one.', { error: file.error })}</div>}
      {state.liveMap?.enabled && (
        <div className="alert alert-info">
          {t('LiveMap is active: the live map, with the players, appears when the server loads it (after the restart) and has drawn the first chunks.')}
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
        {tn('To see it live, with the players, activate {livemap}: it only works on the server, only while this page is open.', {
          livemap: <strong>LiveMap</strong>,
        })}{' '}
        {tml && !installed
          ? tn('You can find it in the {workshop}.', { workshop: <Link to={`/servers/${server.id}/workshop`}>Workshop</Link> })
          : tn('It can be turned off from {page}.', {
              page: <Link to={`/servers/${server.id}/${tml ? 'mods' : 'plugins'}`}>{tml ? t('Mods') : t('Plugins')}</Link>,
            })}
      </span>
      {tml && !installed ? (
        <Link className="btn btn-sm btn-primary" to={`/servers/${server.id}/workshop`}>
          {t('Go to the Workshop')}
        </Link>
      ) : (
        <button type="button" className="btn btn-sm btn-primary" disabled={pending} onClick={activate}>
          {t('Activate LiveMap')}
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
      return <div className="empty">{t('The world does not exist yet: it will be created on the first start of the server, and the map will show up here.')}</div>
    case 'no-colors':
      return (
        <div className="empty">
          {tn('The map colors are missing ({file}): in a development installation they are created with {script}.', {
            file: <span className="mono">addons/dist/map-colors.json</span>,
            script: <span className="mono">addons/build.sh</span>,
          })}
        </div>
      )
    case 'world-error':
      return <div className="alert alert-error">{t('The world file could not be read: {error}', { error: state.worldFile?.error ?? '' })}</div>
    case 'loading':
      return (
        <div className="empty stack-sm">
          <div className="spinner" />
          <p>{t('Reading the world file…')}</p>
          {state.liveMap?.enabled && <p className="small">{t('LiveMap is active: afterwards, the map will be live.')}</p>}
        </div>
      )
    default:
      return null
  }
}

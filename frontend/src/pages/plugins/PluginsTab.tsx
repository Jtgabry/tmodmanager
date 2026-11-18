import { useMemo, useState } from 'react'
import OverflowActions, { type OverflowAction } from '../../components/OverflowActions'
import PageActions from '../../components/PageActions'
import Sheet from '../../components/Sheet'
import { errorMessage } from '../../lib/api'
import { useCurrentServer } from '../../lib/currentServer'
import { formatBytes } from '../../lib/format'
import { pluginDownloadUrl, pluginTitle, useDeletePlugin, usePlugins, useTogglePlugin, versionLabel } from '../../lib/plugins'
import type { BundledPlugin, Plugin } from '../../lib/types'
import { useWindowFileDrop } from '../../lib/useWindowFileDrop'
import { ModInitials } from '../mods/ModIcon'
import PluginUpload from './PluginUpload'
import PluginVersions from './PluginVersions'
import { usePluginUploadQueue } from './pluginUploadQueue'

type Show = 'all' | 'on' | 'off'

const KIND_LABEL: Record<string, string> = { plugin: 'Plugin', library: 'Libreria' }

/** Plugin del server TShock: caricamento delle .dll, attivazione, versioni salvate. */
export default function PluginsTab() {
  const server = useCurrentServer()
  const plugins = usePlugins(server.id)
  const toggle = useTogglePlugin(server.id)
  const remove = useDeletePlugin(server.id)
  const queue = usePluginUploadQueue(server.id)
  const [dialog, setDialog] = useState<'upload' | 'bundled' | null>(null)
  const [versionsOf, setVersionsOf] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<Plugin | null>(null)
  const [query, setQuery] = useState('')
  const [show, setShow] = useState<Show>('all')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Una .dll rilasciata ovunque nella pagina si carica
  const dragging = useWindowFileDrop((files) => {
    setDialog('upload')
    void queue.start(files)
  })

  const list = useMemo(() => plugins.data?.plugins ?? [], [plugins.data])
  const bundled = plugins.data?.bundled ?? []
  const counts = { all: list.length, on: list.filter((p) => p.enabled).length, off: list.filter((p) => !p.enabled).length }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return list.filter((p) => {
      if (show === 'on' && !p.enabled) return false
      if (show === 'off' && p.enabled) return false
      return !q || [p.name, p.title, p.author, p.description].some((v) => v?.toLowerCase().includes(q))
    })
  }, [list, query, show])

  const busy = toggle.isPending || remove.isPending
  const versionsPlugin = versionsOf ? list.find((p) => p.name === versionsOf) : undefined

  const onToggle = (plugin: Plugin) => {
    setError(null)
    setNotice(null)
    toggle.mutate({ name: plugin.name, enabled: !plugin.enabled }, { onError: (err) => setError(errorMessage(err)) })
  }

  const onDelete = (plugin: Plugin) => {
    setError(null)
    setNotice(null)
    remove.mutate(plugin.name, {
      onSuccess: () =>
        setNotice(
          plugin.versions.length > 1
            ? `${pluginTitle(plugin)} spostato nel cestino con tutte le sue ${plugin.versions.length} versioni.`
            : `${pluginTitle(plugin)} spostato nel cestino.`,
        ),
      onError: (err) => setError(errorMessage(err)),
      onSettled: () => setDeleting(null),
    })
  }

  return (
    <div className="stack">
      <PageActions>
        {plugins.data && (
          <span className="muted page-summary">
            {list.length} plugin · {counts.on} {counts.on === 1 ? 'attivo' : 'attivi'}
          </span>
        )}
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => setDialog('bundled')} title="Plugin inclusi in TShock">
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" />
            </svg>
            <span className="hide-narrow">Inclusi in TShock</span>
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setDialog('upload')}>
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 16V4" />
              <path d="M7 9l5-5 5 5" />
              <path d="M4 20h16" />
            </svg>
            Carica plugin
          </button>
        </div>
      </PageActions>

      {plugins.isLoading && <div className="spinner" />}
      {plugins.error && <div className="alert alert-error">{errorMessage(plugins.error)}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      {plugins.data && (
        <>
          <div className="mods-toolbar">
            <label className="search-box">
              <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" />
              </svg>
              <input
                type="search"
                placeholder="Cerca per nome, autore o descrizione…"
                aria-label="Cerca plugin"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="segmented" role="group" aria-label="Stato dei plugin">
              {(
                [
                  ['all', 'Tutti'],
                  ['on', 'Attivi'],
                  ['off', 'Disattivati'],
                ] as const
              ).map(([value, label]) => (
                <button key={value} type="button" className={show === value ? 'active' : ''} aria-pressed={show === value} onClick={() => setShow(value)}>
                  {label} {counts[value]}
                </button>
              ))}
            </div>
          </div>

          {visible.length === 0 ? (
            <div className="empty">
              {list.length === 0 ? (
                <>
                  Nessun plugin caricato. Trascina qui una .dll, oppure usa <strong>Carica plugin</strong>.
                </>
              ) : (
                'Nessun plugin corrisponde ai filtri.'
              )}
            </div>
          ) : (
            <div className="mod-grid">
              {visible.map((plugin) => (
                <PluginCard
                  key={plugin.name}
                  plugin={plugin}
                  serverId={server.id}
                  busy={busy}
                  onToggle={() => onToggle(plugin)}
                  onVersions={() => setVersionsOf(plugin.name)}
                  onDelete={() => setDeleting(plugin)}
                />
              ))}
            </div>
          )}
        </>
      )}

      <Sheet open={dialog === 'upload'} title="Carica plugin" keepMounted onClose={() => setDialog(null)}>
        <PluginUpload queue={queue} />
      </Sheet>

      <Sheet open={dialog === 'bundled'} title="Plugin inclusi in TShock" onClose={() => setDialog(null)}>
        <BundledList plugins={bundled} />
      </Sheet>

      <Sheet open={versionsPlugin !== undefined} title={versionsPlugin ? `Versioni di ${pluginTitle(versionsPlugin)}` : ''} wide onClose={() => setVersionsOf(null)}>
        {versionsPlugin && <PluginVersions serverId={server.id} plugin={versionsPlugin} />}
      </Sheet>

      <Sheet open={deleting !== null} title="Eliminare il plugin?" onClose={() => setDeleting(null)}>
        {deleting && (
          <div className="stack">
            <p>
              <strong>{pluginTitle(deleting)}</strong>
              {deleting.versions.length > 1 ? ` e tutte le sue ${deleting.versions.length} versioni salvate` : ''} andranno nel cestino
              {deleting.enabled ? ', e TShock non lo caricherà più dal prossimo riavvio' : ''}. Dal cestino si può ripristinare per 30 giorni.
            </p>
            <div className="btn-row">
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => onDelete(deleting)}>
                Elimina
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setDeleting(null)}>
                Annulla
              </button>
            </div>
          </div>
        )}
      </Sheet>

      {dragging && dialog !== 'upload' && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-box">
            <svg className="drop-overlay-icon" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 6.5a.5.5 0 0 1 .5.5v1.5H10a.5.5 0 0 1 0 1H8.5V11a.5.5 0 0 1-1 0V9.5H6a.5.5 0 0 1 0-1h1.5V7a.5.5 0 0 1 .5-.5" />
              <path d="M14 4.5V14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2h5.5zm-3 0A1.5 1.5 0 0 1 9.5 3V1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5z" />
            </svg>
            <strong>Rilascia per aggiungere il plugin</strong>
            <span className="muted">File .dll: se il plugin c'è già, si aggiunge come nuova versione</span>
          </div>
        </div>
      )}
    </div>
  )
}

function PluginCard(props: { plugin: Plugin; serverId: string; busy: boolean; onToggle: () => void; onVersions: () => void; onDelete: () => void }) {
  const { plugin } = props
  const title = pluginTitle(plugin)
  const selected = plugin.versions.find((v) => v.id === plugin.selected)

  return (
    <article className={plugin.enabled ? 'mod-card' : 'mod-card mod-card-off'}>
      <div className="mod-card-head">
        <button type="button" className="mod-icon-button dim" onClick={props.onVersions} aria-label={`Versioni di ${title}`} disabled={plugin.error !== null || plugin.addon}>
          <ModInitials title={title} />
        </button>
        <div className="mod-card-heading">
          <h3 className="mod-title dim">{title}</h3>
          {plugin.author && <div className="mod-author">di {plugin.author}</div>}
          <div className="pill-row">
            <span className={plugin.enabled ? 'pill pill-on' : 'pill pill-off'}>{plugin.enabled ? 'Attivo' : 'Disattivato'}</span>
            {selected && <span className="pill pill-plain">{versionLabel(selected)}</span>}
            {plugin.versions.length > 1 && (
              <button type="button" className="pill pill-plain pill-button" onClick={props.onVersions} title="Versioni salvate">
                {plugin.versions.length} versioni
              </button>
            )}
            {plugin.addon && (
              <span className="pill pill-update" title="Distribuito con tModManager: si aggiorna insieme al pannello">
                add-on tModManager
              </span>
            )}
            {plugin.kind === 'library' && (
              <span className="pill pill-plain" title="Non contiene un plugin: è una dipendenza di altri plugin">
                libreria
              </span>
            )}
          </div>
        </div>
      </div>

      {plugin.error && <p className="error-text">{plugin.error}</p>}
      {plugin.description && <p className="mod-description-short dim">{plugin.description}</p>}

      <div className="mod-meta">
        {plugin.kind ? KIND_LABEL[plugin.kind] : 'File non valido'}
        {plugin.title && plugin.title !== plugin.name && <span className="mono"> · {plugin.name}</span>}
        {selected && ` · ${formatBytes(selected.size)}`}
      </div>

      <OverflowActions actions={pluginActions(props, title)} menuLabel={`Altre azioni per ${title}`} />
    </article>
  )
}

const downloadIcon = (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 4v12" />
    <path d="M7 11l5 5 5-5" />
    <path d="M4 20h16" />
  </svg>
)

const deleteIcon = (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 7h16" />
    <path d="M10 11v6M14 11v6" />
    <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
    <path d="M9 7V4h6v3" />
  </svg>
)

/** Azioni in fondo alla card, dalla più importante: se la card è stretta le ultime vanno nel menu «⋯». */
function pluginActions(props: { plugin: Plugin; serverId: string; busy: boolean; onToggle: () => void; onVersions: () => void; onDelete: () => void }, title: string): OverflowAction[] {
  const { plugin } = props
  const toggleLabel = plugin.enabled ? 'Disattiva' : 'Attiva'
  const toggleDisabled = props.busy || plugin.error !== null
  const url = plugin.selected ? pluginDownloadUrl(props.serverId, plugin.name, plugin.selected) : null
  const download = () => {
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.download = ''
    a.click()
  }
  return [
    {
      key: 'toggle',
      priority: 4,
      label: toggleLabel,
      disabled: toggleDisabled,
      onSelect: props.onToggle,
      inline: (
        <button type="button" className={plugin.enabled ? 'btn btn-sm btn-toggle-on' : 'btn btn-sm'} disabled={toggleDisabled} onClick={props.onToggle}>
          {toggleLabel}
        </button>
      ),
    },
    ...(plugin.error || plugin.addon
      ? []
      : [
          {
            key: 'versions',
            priority: 3,
            label: 'Versioni',
            onSelect: props.onVersions,
            inline: (
              <button type="button" className="btn btn-sm" onClick={props.onVersions}>
                Versioni
              </button>
            ),
          },
        ]),
    ...(url
      ? [
          {
            key: 'download',
            priority: 1,
            end: true,
            label: 'Scarica la .dll',
            icon: downloadIcon,
            onSelect: download,
            inline: (
              <a className="btn btn-sm btn-icon" href={url} download aria-label={`Scarica ${title}`} title="Scarica la versione scelta">
                {downloadIcon}
              </a>
            ),
          },
        ]
      : []),
    ...(plugin.addon
      ? []
      : [
          {
            key: 'delete',
            priority: 2,
            end: true,
            danger: true,
            label: 'Elimina',
            icon: deleteIcon,
            disabled: props.busy,
            onSelect: props.onDelete,
            inline: (
              <button type="button" className="btn btn-sm btn-icon btn-danger-outline" disabled={props.busy} onClick={props.onDelete} aria-label={`Elimina ${title}`} title="Elimina">
                {deleteIcon}
              </button>
            ),
          },
        ]),
  ]
}

/** Plugin dell'installazione di TShock: sempre attivi, si aggiornano con TShock. */
function BundledList({ plugins }: { plugins: BundledPlugin[] }) {
  if (plugins.length === 0) return <p className="muted">Nessun plugin nell'installazione di TShock.</p>
  return (
    <div className="stack">
      <p className="hint">
        Fanno parte dell'installazione di TShock: sono sempre attivi e si aggiornano insieme a TShock, non da qui.
      </p>
      <ul className="archive-versions">
        {plugins.map((p) => (
          <li key={p.file} className="archive-version">
            <span className="archive-version-name">{p.title ?? p.file}</span>
            {p.version && <span className="pill pill-plain">v{p.version}</span>}
            <span className="archive-version-meta">
              <span className="mono">{p.file}</span> · {formatBytes(p.size)}
              {p.author && ` · ${p.author}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

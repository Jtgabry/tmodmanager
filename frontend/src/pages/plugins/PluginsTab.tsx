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
import { t, tn } from '../../i18n'

type Show = 'all' | 'on' | 'off'

const kindLabel = (kind: string): string | undefined => ({ plugin: 'Plugin', library: t('Library') })[kind]

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
            ? t('{plugin} moved to the trash with all its {count} versions.', { plugin: pluginTitle(plugin), count: plugin.versions.length })
            : t('{plugin} moved to the trash.', { plugin: pluginTitle(plugin) }),
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
            {t('{count} plugins', { count: list.length })} · {counts.on === 1 ? t('1 active') : t('{count} active', { count: counts.on })}
          </span>
        )}
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => setDialog('bundled')} title={t('Plugins included in TShock')}>
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" />
            </svg>
            <span className="hide-narrow">{t('Included in TShock')}</span>
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setDialog('upload')}>
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 16V4" />
              <path d="M7 9l5-5 5 5" />
              <path d="M4 20h16" />
            </svg>
            {t('Upload plugins')}
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
                placeholder={t('Search by name, author or description…')}
                aria-label={t('Search plugins')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="segmented" role="group" aria-label={t('Plugin status')}>
              {(
                [
                  ['all', t('All')],
                  ['on', t('Enabled')],
                  ['off', t('Disabled')],
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
                  {tn('No plugins uploaded. Drag a .dll here, or use {button}.', { button: <strong>{t('Upload plugins')}</strong> })}
                </>
              ) : (
                t('No plugin matches the filters.')
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

      <Sheet open={dialog === 'upload'} title={t('Upload plugins')} keepMounted onClose={() => setDialog(null)}>
        <PluginUpload queue={queue} />
      </Sheet>

      <Sheet open={dialog === 'bundled'} title={t('Plugins included in TShock')} onClose={() => setDialog(null)}>
        <BundledList plugins={bundled} />
      </Sheet>

      <Sheet open={versionsPlugin !== undefined} title={versionsPlugin ? t('Versions of {name}', { name: pluginTitle(versionsPlugin) }) : ''} wide onClose={() => setVersionsOf(null)}>
        {versionsPlugin && <PluginVersions serverId={server.id} plugin={versionsPlugin} />}
      </Sheet>

      <Sheet open={deleting !== null} title={t('Delete the plugin?')} onClose={() => setDeleting(null)}>
        {deleting && (
          <div className="stack">
            <p>
              {tn(
                deleting.versions.length > 1
                  ? '{plugin} and all its {count} saved versions will go to the trash'
                  : '{plugin} will go to the trash',
                { plugin: <strong>{pluginTitle(deleting)}</strong>, count: deleting.versions.length },
              )}
              {deleting.enabled ? t(', and TShock will no longer load it from the next restart') : ''}.{' '}
              {t('It can be restored from the trash for 30 days.')}
            </p>
            <div className="btn-row">
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => onDelete(deleting)}>
                {t('Delete')}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setDeleting(null)}>
                {t('Cancel')}
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
            <strong>{t('Drop to add the plugin')}</strong>
            <span className="muted">{t('.dll files: if the plugin is already there, it is added as a new version')}</span>
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
        <button type="button" className="mod-icon-button dim" onClick={props.onVersions} aria-label={t('Versions of {name}', { name: title })} disabled={plugin.error !== null || plugin.addon}>
          <ModInitials title={title} />
        </button>
        <div className="mod-card-heading">
          <h3 className="mod-title dim">{title}</h3>
          {plugin.author && <div className="mod-author">{t('by {author}', { author: plugin.author })}</div>}
          <div className="pill-row">
            <span className={plugin.enabled ? 'pill pill-on' : 'pill pill-off'}>{plugin.enabled ? t('Active') : t('Inactive')}</span>
            {selected && <span className="pill pill-plain">{versionLabel(selected)}</span>}
            {plugin.versions.length > 1 && (
              <button type="button" className="pill pill-plain pill-button" onClick={props.onVersions} title={t('Saved versions')}>
                {t('{count} versions', { count: plugin.versions.length })}
              </button>
            )}
            {plugin.addon && (
              <span className="pill pill-update" title={t('Shipped with tModManager: it is updated together with the panel')}>
                {t('tModManager add-on')}
              </span>
            )}
            {plugin.kind === 'library' && (
              <span className="pill pill-plain" title={t('It does not contain a plugin: it is a dependency of other plugins')}>
                {t('library')}
              </span>
            )}
          </div>
        </div>
      </div>

      {plugin.error && <p className="error-text">{plugin.error}</p>}
      {plugin.description && <p className="mod-description-short dim">{plugin.description}</p>}

      <div className="mod-meta">
        {plugin.kind ? kindLabel(plugin.kind) : t('Invalid file')}
        {plugin.title && plugin.title !== plugin.name && <span className="mono"> · {plugin.name}</span>}
        {selected && ` · ${formatBytes(selected.size)}`}
      </div>

      <OverflowActions actions={pluginActions(props, title)} menuLabel={t('More actions for {name}', { name: title })} />
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
  const toggleLabel = plugin.enabled ? t('Deactivate') : t('Activate')
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
            label: t('Versions'),
            onSelect: props.onVersions,
            inline: (
              <button type="button" className="btn btn-sm" onClick={props.onVersions}>
                {t('Versions')}
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
            label: t('Download the .dll'),
            icon: downloadIcon,
            onSelect: download,
            inline: (
              <a className="btn btn-sm btn-icon" href={url} download aria-label={t('Download {name}', { name: title })} title={t('Download the chosen version')}>
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
            label: t('Delete'),
            icon: deleteIcon,
            disabled: props.busy,
            onSelect: props.onDelete,
            inline: (
              <button type="button" className="btn btn-sm btn-icon btn-danger-outline" disabled={props.busy} onClick={props.onDelete} aria-label={t('Delete {name}', { name: title })} title={t('Delete')}>
                {deleteIcon}
              </button>
            ),
          },
        ]),
  ]
}

/** Plugin dell'installazione di TShock: sempre attivi, si aggiornano con TShock. */
function BundledList({ plugins }: { plugins: BundledPlugin[] }) {
  if (plugins.length === 0) return <p className="muted">{t('No plugins in the TShock installation.')}</p>
  return (
    <div className="stack">
      <p className="hint">
        {t('They are part of the TShock installation: they are always active and are updated together with TShock, not from here.')}
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

import { useState } from 'react'
import { errorMessage } from '../../lib/api'
import { formatBytes, formatDate } from '../../lib/format'
import { pluginDownloadUrl, pluginTitle, useDeletePluginVersion, usePruneVersions, useUsePluginVersion, versionLabel } from '../../lib/plugins'
import type { Plugin } from '../../lib/types'
import { t, tn } from '../../i18n'

const trashIcon = (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 7h16" />
    <path d="M10 11v6M14 11v6" />
    <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
    <path d="M9 7V4h6v3" />
  </svg>
)

const downloadIcon = (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 4v12" />
    <path d="M7 11l5 5 5-5" />
    <path d="M4 20h16" />
  </svg>
)

/** Versioni salvate di un plugin: scegliere quella da usare, scaricarle, eliminarle una a una o tutte le vecchie. */
export default function PluginVersions({ serverId, plugin }: { serverId: string; plugin: Plugin }) {
  const use = useUsePluginVersion(serverId)
  const remove = useDeletePluginVersion(serverId)
  const prune = usePruneVersions(serverId)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const title = pluginTitle(plugin)
  const busy = use.isPending || remove.isPending || prune.isPending
  const old = plugin.versions.filter((v) => v.id !== plugin.selected)
  // Due versioni con lo stesso numero (ricompilate senza cambiarlo): si distinguono per l'impronta
  const repeated = new Set(plugin.versions.map((v) => v.version).filter((v, i, all) => v && all.indexOf(v) !== i))

  const reset = () => {
    setNotice(null)
    setError(null)
  }

  const onUse = (id: string) => {
    reset()
    use.mutate(
      { name: plugin.name, id },
      {
        onSuccess: (p) => {
          const v = p.versions.find((x) => x.id === id)
          setNotice(
            p.enabled
              ? t('{plugin}: now using {version}. Restart the server to load it.', { plugin: title, version: v ? versionLabel(v) : t('the chosen version') })
              : t('{plugin}: chose {version}, it will be used when you activate the plugin.', { plugin: title, version: v ? versionLabel(v) : t('the version') }),
          )
        },
        onError: (err) => setError(errorMessage(err)),
      },
    )
  }

  const onDelete = (id: string) => {
    reset()
    const v = plugin.versions.find((x) => x.id === id)
    remove.mutate(
      { name: plugin.name, id },
      {
        onSuccess: () => setNotice(t('{plugin} {version} moved to the trash.', { plugin: title, version: v ? versionLabel(v) : '' })),
        onError: (err) => setError(errorMessage(err)),
        onSettled: () => setConfirm(null),
      },
    )
  }

  const onPrune = () => {
    reset()
    prune.mutate(plugin.name, {
      onSuccess: (r) => setNotice(r.removed === 1 ? t('1 version moved to the trash.') : t('{count} versions moved to the trash.', { count: r.removed })),
      onError: (err) => setError(errorMessage(err)),
      onSettled: () => setConfirm(null),
    })
  }

  return (
    <div className="stack">
      <p className="hint">
        {tn(
          'Every uploaded .dll stays saved here. Only the chosen version is in {folder}: changing it replaces the file, and TShock loads it on the next restart. Deleted versions go to the trash.',
          { folder: <span className="mono">ServerPlugins/</span> },
        )}
      </p>

      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      <ul className="archive-versions">
        {plugin.versions.map((v) => {
          const selected = v.id === plugin.selected
          return (
            <li key={v.id} className={selected ? 'archive-version archive-version-installed' : 'archive-version'}>
              <span className="archive-version-name">{versionLabel(v)}</span>
              {selected && <span className={plugin.enabled ? 'pill pill-on' : 'pill pill-plain'}>{plugin.enabled ? t('in use') : t('chosen')}</span>}
              <span className="archive-version-meta">
                {formatBytes(v.size)} · {t('uploaded {date}', { date: formatDate(v.uploadedAt) })}
                {(repeated.has(v.version) || !v.version) && <span className="mono"> · {v.id.slice(0, 8)}</span>}
              </span>
              <span className="archive-version-actions">
                {confirm === v.id ? (
                  <>
                    <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => onDelete(v.id)}>
                      {t('Delete')}
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(null)}>
                      {t('Cancel')}
                    </button>
                  </>
                ) : (
                  <>
                    {!selected && (
                      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onUse(v.id)}>
                        {plugin.enabled ? t('Use this one') : t('Choose this one')}
                      </button>
                    )}
                    <a
                      className="btn btn-sm btn-icon"
                      href={pluginDownloadUrl(serverId, plugin.name, v.id)}
                      download
                      aria-label={t('Download {name}', { name: `${title} ${versionLabel(v)}` })}
                      title={t('Download')}
                    >
                      {downloadIcon}
                    </a>
                    {/* La versione attiva non si elimina (prima se ne sceglie un'altra); l'unica versione si toglie eliminando il plugin */}
                    {!(selected && plugin.enabled) && plugin.versions.length > 1 && (
                      <button
                        type="button"
                        className="btn btn-sm btn-icon btn-danger-outline"
                        disabled={busy}
                        aria-label={t('Delete {name}', { name: `${title} ${versionLabel(v)}` })}
                        title={t('Delete this version')}
                        onClick={() => setConfirm(v.id)}
                      >
                        {trashIcon}
                      </button>
                    )}
                  </>
                )}
              </span>
            </li>
          )
        })}
      </ul>

      {old.length > 0 && (
        <div className="btn-row">
          {confirm === 'old' ? (
            <>
              <span className="small">
                {old.length === 1
                  ? t('The version not chosen will go to the trash.')
                  : t('The {count} versions not chosen will go to the trash.', { count: old.length })}
              </span>
              <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={onPrune}>
                {t('Confirm')}
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(null)}>
                {t('Cancel')}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-sm btn-danger-outline" disabled={busy} onClick={() => setConfirm('old')}>
              {trashIcon}
              {t('Delete the other versions ({count})', { count: old.length })}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

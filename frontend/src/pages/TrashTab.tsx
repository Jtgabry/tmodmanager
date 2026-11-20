import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { errorMessage, statusOf } from '../lib/api'
import { useCurrentServer } from '../lib/currentServer'
import { formatBytes, formatDate } from '../lib/format'
import { useTrash, useTrashActions } from '../lib/trash'
import type { TrashItem } from '../lib/types'
import { t } from '../i18n'

const rootLabel = (root: string): string | undefined => ({ save: 'SaveData', worlds: t('Worlds'), tml: 'tModLoader' })[root]

const origin = (item: TrashItem) => {
  if (item.kind === 'mod') return `Mods/${item.modName}.tmod`
  if (item.kind === 'plugin') {
    if (item.path === 'file') return `ServerPlugins/${item.name}`
    if (item.path === 'plugin') return t('Plugin {name}, with all its versions', { name: item.modName ?? '' })
    return t('Version of {name}', { name: item.modName ?? '' })
  }
  return `${rootLabel(item.root ?? '') ?? item.root}/${item.path}`
}

const KIND_ICON: Record<TrashItem['kind'], string> = { mod: '🧩 ', plugin: '🔌 ', file: '📄 ' }

/** Colore del conto alla rovescia: rosso negli ultimi 3 giorni, giallo negli ultimi 7. */
const daysClass = (days: number) => (days <= 3 ? 'tag tag-danger' : days <= 7 ? 'tag tag-warning' : 'tag')

const daysLabel = (days: number) => (days === 0 ? t('today') : days === 1 ? t('1 day') : t('{count} days', { count: days }))

export default function TrashTab() {
  const server = useCurrentServer()
  const { can } = useAuth()
  const trash = useTrash(server.id)
  const actions = useTrashActions(server.id)
  const [kind, setKind] = useState<'all' | 'file' | 'mod' | 'plugin'>('all')
  const [conflict, setConflict] = useState<{ id: string; message: string } | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [confirmEmpty, setConfirmEmpty] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const both = can(server.id, 'files') && can(server.id, 'mods')
  const items = (trash.data ?? []).filter((i) => kind === 'all' || i.kind === kind)
  const total = items.reduce((sum, i) => sum + i.size, 0)

  const reset = () => {
    setNotice(null)
    setError(null)
    setConflict(null)
    setConfirm(null)
  }

  const restore = (item: TrashItem, overwrite = false) => {
    reset()
    actions.restore.mutate(
      { id: item.id, overwrite },
      {
        onSuccess: (r) => {
          const what =
            item.kind === 'mod'
              ? t('The mod {name} has been restored.', { name: item.modName ?? '' })
              : item.kind === 'plugin'
                ? item.path === 'plugin'
                  ? t('The plugin {name} has been restored.', { name: item.name })
                  : item.path === 'file'
                    ? t('"{name}" has been restored.', { name: item.name })
                    : item.modVersion
                      ? t('Version v{version} of {name} has been restored.', { version: item.modVersion, name: item.modName ?? '' })
                      : t('The version of {name} has been restored.', { name: item.modName ?? '' })
                : t('"{name}" has been restored.', { name: item.path ?? '' })
          const extra =
            item.kind === 'mod'
              ? t('It is disabled: enable it from the Mods tab.')
              : item.kind === 'plugin' && item.path === 'plugin'
                ? t('It is inactive: activate it from the Plugins tab.')
                : item.kind === 'plugin' && item.path?.startsWith('version:')
                  ? t('It is back among the plugin versions.')
              : r.replaced
                ? t('The version that was there before went to the trash.')
                : ''
          const replaced = r.replacedVersion ? ` ${t('(Replaced version {version}.)', { version: r.replacedVersion })}` : ''
          setNotice(`${what}${extra && ` ${extra}`}${replaced}`)
        },
        onError: (err) => {
          if (statusOf(err) === 409) setConflict({ id: item.id, message: errorMessage(err) })
          else setError(errorMessage(err))
        },
      },
    )
  }

  if (trash.isLoading) return <div className="spinner" />
  if (trash.error) return <div className="alert alert-error">{errorMessage(trash.error)}</div>

  return (
    <div className="card">
      <div className="section-header">
        <h2>{t('Trash')}</h2>
        <div className="btn-row">
          {both && (
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label={t('Type')}>
              <option value="all">{t('All')}</option>
              <option value="file">{t('Files')}</option>
              <option value="mod">{t('Mods')}</option>
              <option value="plugin">{t('Plugins')}</option>
            </select>
          )}
          {(trash.data?.length ?? 0) > 0 &&
            (confirmEmpty ? (
              <>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={actions.empty.isPending}
                  onClick={() =>
                    actions.empty.mutate(undefined, {
                      onSuccess: (r) => setNotice(t('Trash emptied ({count} items deleted permanently).', { count: r.removed })),
                      onError: (err) => setError(errorMessage(err)),
                      onSettled: () => setConfirmEmpty(false),
                    })
                  }
                >
                  {t('Confirm: delete everything')}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmEmpty(false)}>
                  {t('Cancel')}
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-danger-outline btn-sm" onClick={() => setConfirmEmpty(true)}>
                {t('Empty trash')}
              </button>
            ))}
        </div>
      </div>
      <p className="muted small">
        {t(
          'Deleted files, mods and plugins, and the versions replaced by an upload, stay here for 30 days; then they are deleted permanently and automatically.',
        )}
        {items.length > 0 && ` ${t('{count} items, {size}.', { count: items.length, size: formatBytes(total) })}`}
      </p>

      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      {items.length === 0 ? (
        <p className="muted">{t('The trash is empty.')}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('Item')}</th>
                <th>{t('Deleted')}</th>
                <th>{t('Deleted forever in')}</th>
                <th>{t('Size')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <div>
                      <span aria-hidden>{item.kind === 'file' && item.isDir ? '📁 ' : KIND_ICON[item.kind]}</span>
                      <strong>{item.kind === 'mod' ? item.modName : item.name}</strong>
                      {item.modVersion && <span className="muted small"> v{item.modVersion}</span>}
                      {item.reason === 'replaced' && <span className="tag tag-accent"> {t('replaced version')}</span>}
                    </div>
                    <div className="muted small mono">{origin(item)}</div>
                    {conflict?.id === item.id && (
                      <div className="btn-row">
                        <span className="small error-text">{conflict.message}.</span>
                        <button type="button" className="btn btn-warning btn-sm" onClick={() => restore(item, true)}>
                          {item.kind === 'mod' ? t('Replace the installed version') : t('Replace the current one')}
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConflict(null)}>
                          {t('Cancel')}
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="muted small">{formatDate(item.deletedAt)}</td>
                  <td>
                    <span className={daysClass(item.daysLeft)} title={t('Deleted permanently on {date}', { date: formatDate(item.expiresAt) })}>
                      {daysLabel(item.daysLeft)}
                    </span>
                  </td>
                  <td className="mono">{formatBytes(item.size)}</td>
                  <td>
                    <div className="btn-row nowrap">
                      <button type="button" className="btn btn-sm" disabled={actions.restore.isPending} onClick={() => restore(item)}>
                        {t('Restore')}
                      </button>
                      {confirm === item.id ? (
                        <>
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
                            onClick={() =>
                              actions.remove.mutate(item.id, {
                                onError: (err) => setError(errorMessage(err)),
                                onSettled: () => setConfirm(null),
                              })
                            }
                          >
                            {t('Delete forever')}
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>
                            {t('Cancel')}
                          </button>
                        </>
                      ) : (
                        <button type="button" className="btn btn-danger-outline btn-sm" onClick={() => setConfirm(item.id)}>
                          {t('Delete')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

import { type FormEvent, useState } from 'react'
import { errorMessage } from '../../lib/api'
import type { ModUpdate } from '../../lib/types'
import { useWorkshopLink, useWorkshopSearch } from '../../lib/workshop'
import { intlLocale, t } from '../../i18n'

const sourceLabel = (source: 'auto' | 'manual') => (source === 'auto' ? t('recognized automatically') : t('linked by hand'))

/** Collegamento di una mod alla sua pagina del Workshop, nei dettagli della mod. */
export default function WorkshopLinkEditor(props: { serverId: string; modName: string; update: ModUpdate | undefined; canSearch: boolean }) {
  const { serverId, modName, update } = props
  const link = useWorkshopLink(serverId)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const results = useWorkshopSearch(serverId, editing && props.canSearch ? query : '')

  const save = (workshop: string | null) =>
    link.mutate({ name: modName, workshop }, { onSuccess: () => setEditing(false) })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    save(value)
  }

  return (
    <div className="workshop-link">
      {update?.workshopId ? (
        <span>
          <a href={update.url ?? undefined} target="_blank" rel="noreferrer noopener">
            {update.title ?? t('Item {id}', { id: update.workshopId })}
          </a>{' '}
          <span className="muted small">({update.link ? sourceLabel(update.link) : ''})</span>
        </span>
      ) : (
        <span className="muted">{update?.link === 'manual' ? t('Marked as not on the Workshop') : t('Not linked')}</span>
      )}{' '}
      {!editing && (
        <button type="button" className="link-button small" onClick={() => setEditing(true)}>
          {update?.workshopId ? t('Change') : t('Link')}
        </button>
      )}

      {editing && (
        <div className="stack workshop-link-editor">
          <form className="form-inline" onSubmit={submit}>
            <label className="field">
              <span>{t('Workshop page link or ID')}</span>
              <input
                autoFocus
                required
                value={value}
                placeholder="https://steamcommunity.com/sharedfiles/filedetails/?id=…"
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
            <button type="submit" className="btn btn-primary btn-sm" disabled={link.isPending}>
              {t('Link')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
              {t('Cancel')}
            </button>
          </form>

          {props.canSearch && (
            <form
              className="form-inline"
              onSubmit={(e) => {
                e.preventDefault()
                setQuery(search.trim())
              }}
            >
              <label className="field">
                <span>{t('Or search the Workshop')}</span>
                <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={modName} />
              </label>
              <button type="submit" className="btn btn-sm">
                {t('Search')}
              </button>
            </form>
          )}
          {results.isFetching && <span className="muted small">{t('Searching…')}</span>}
          {results.error && <span className="error-text small">{errorMessage(results.error)}</span>}
          {results.data && (
            <ul className="update-list">
              {results.data.length === 0 && <li className="muted">{t('No results.')}</li>}
              {results.data.map((r) => (
                <li key={r.id}>
                  <a href={r.url} target="_blank" rel="noreferrer noopener">
                    {r.title ?? r.id}
                  </a>{' '}
                  <span className="muted small mono">{r.modName}</span>{' '}
                  {r.subscriptions !== null && <span className="muted small">· {t('{count} subscribers', { count: r.subscriptions.toLocaleString(intlLocale()) })}</span>}{' '}
                  <button type="button" className="btn btn-sm" disabled={link.isPending} onClick={() => save(r.id)}>
                    {t('Use this one')}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="btn-row">
            <button type="button" className="btn btn-ghost btn-sm" disabled={link.isPending} onClick={() => save(null)}>
              {t('It is not on the Workshop')}
            </button>
            {update?.link === 'manual' && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={link.isPending}
                onClick={() => link.mutate({ name: modName, reset: true }, { onSuccess: () => setEditing(false) })}
              >
                {t('Back to automatic recognition')}
              </button>
            )}
          </div>
          {link.error && <span className="error-text small">{errorMessage(link.error)}</span>}
        </div>
      )}
    </div>
  )
}

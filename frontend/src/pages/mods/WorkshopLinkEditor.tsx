import { type FormEvent, useState } from 'react'
import { errorMessage } from '../../lib/api'
import type { ModUpdate } from '../../lib/types'
import { useWorkshopLink, useWorkshopSearch } from '../../lib/workshop'

const SOURCE_LABEL = { auto: 'riconosciuta in automatico', manual: 'collegata a mano' }

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
            {update.title ?? `Elemento ${update.workshopId}`}
          </a>{' '}
          <span className="muted small">({update.link ? SOURCE_LABEL[update.link] : ''})</span>
        </span>
      ) : (
        <span className="muted">{update?.link === 'manual' ? 'Segnata come non presente nel Workshop' : 'Non collegata'}</span>
      )}{' '}
      {!editing && (
        <button type="button" className="link-button small" onClick={() => setEditing(true)}>
          {update?.workshopId ? 'Cambia' : 'Collega'}
        </button>
      )}

      {editing && (
        <div className="stack workshop-link-editor">
          <form className="form-inline" onSubmit={submit}>
            <label className="field">
              <span>Link della pagina del Workshop o ID</span>
              <input
                autoFocus
                required
                value={value}
                placeholder="https://steamcommunity.com/sharedfiles/filedetails/?id=…"
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
            <button type="submit" className="btn btn-primary btn-sm" disabled={link.isPending}>
              Collega
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
              Annulla
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
                <span>Oppure cerca nel Workshop</span>
                <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={modName} />
              </label>
              <button type="submit" className="btn btn-sm">
                Cerca
              </button>
            </form>
          )}
          {results.isFetching && <span className="muted small">Ricerca…</span>}
          {results.error && <span className="error-text small">{errorMessage(results.error)}</span>}
          {results.data && (
            <ul className="update-list">
              {results.data.length === 0 && <li className="muted">Nessun risultato.</li>}
              {results.data.map((r) => (
                <li key={r.id}>
                  <a href={r.url} target="_blank" rel="noreferrer noopener">
                    {r.title ?? r.id}
                  </a>{' '}
                  <span className="muted small mono">{r.modName}</span>{' '}
                  {r.subscriptions !== null && <span className="muted small">· {r.subscriptions.toLocaleString('it')} iscritti</span>}{' '}
                  <button type="button" className="btn btn-sm" disabled={link.isPending} onClick={() => save(r.id)}>
                    Usa questa
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="btn-row">
            <button type="button" className="btn btn-ghost btn-sm" disabled={link.isPending} onClick={() => save(null)}>
              Non è nel Workshop
            </button>
            {update?.link === 'manual' && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={link.isPending}
                onClick={() => link.mutate({ name: modName, reset: true }, { onSuccess: () => setEditing(false) })}
              >
                Torna al riconoscimento automatico
              </button>
            )}
          </div>
          {link.error && <span className="error-text small">{errorMessage(link.error)}</span>}
        </div>
      )}
    </div>
  )
}

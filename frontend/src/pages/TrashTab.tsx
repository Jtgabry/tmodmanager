import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { errorMessage, statusOf } from '../lib/api'
import { useCurrentServer } from '../lib/currentServer'
import { formatBytes, formatDate } from '../lib/format'
import { useTrash, useTrashActions } from '../lib/trash'
import type { TrashItem } from '../lib/types'

const ROOT_LABEL: Record<string, string> = { save: 'SaveData', worlds: 'Mondi', tml: 'tModLoader' }

const origin = (item: TrashItem) => {
  if (item.kind === 'mod') return `Mods/${item.modName}.tmod`
  if (item.kind === 'plugin') {
    if (item.path === 'file') return `ServerPlugins/${item.name}`
    if (item.path === 'plugin') return `Plugin ${item.modName}, con tutte le versioni`
    return `Versione di ${item.modName}`
  }
  return `${ROOT_LABEL[item.root ?? ''] ?? item.root}/${item.path}`
}

const KIND_ICON: Record<TrashItem['kind'], string> = { mod: '🧩 ', plugin: '🔌 ', file: '📄 ' }

/** Colore del conto alla rovescia: rosso negli ultimi 3 giorni, giallo negli ultimi 7. */
const daysClass = (days: number) => (days <= 3 ? 'tag tag-danger' : days <= 7 ? 'tag tag-warning' : 'tag')

const daysLabel = (days: number) => (days === 0 ? 'oggi' : days === 1 ? '1 giorno' : `${days} giorni`)

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
              ? `La mod ${item.modName}`
              : item.kind === 'plugin'
                ? item.path === 'plugin'
                  ? `Il plugin ${item.name}`
                  : item.path === 'file'
                    ? `"${item.name}"`
                    : `La versione ${item.modVersion ? `v${item.modVersion} ` : ''}di ${item.modName}`
                : `"${item.path}"`
          const extra =
            item.kind === 'mod'
              ? ' È disabilitata: abilitala dalla scheda Mod.'
              : item.kind === 'plugin' && item.path === 'plugin'
                ? ' È disattivato: attivalo dalla scheda Plugin.'
                : item.kind === 'plugin' && item.path?.startsWith('version:')
                  ? ' È di nuovo tra le versioni del plugin.'
              : r.replaced
                ? ' La versione che c\'era prima è finita nel cestino.'
                : ''
          setNotice(`${what} è stato ripristinato.${extra}${r.replacedVersion ? ` (Sostituita la versione ${r.replacedVersion}.)` : ''}`)
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
        <h2>Cestino</h2>
        <div className="btn-row">
          {both && (
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Tipo">
              <option value="all">Tutto</option>
              <option value="file">File</option>
              <option value="mod">Mod</option>
              <option value="plugin">Plugin</option>
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
                      onSuccess: (r) => setNotice(`Cestino svuotato (${r.removed} elementi cancellati definitivamente).`),
                      onError: (err) => setError(errorMessage(err)),
                      onSettled: () => setConfirmEmpty(false),
                    })
                  }
                >
                  Conferma: cancella tutto
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmEmpty(false)}>
                  Annulla
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-danger-outline btn-sm" onClick={() => setConfirmEmpty(true)}>
                Svuota cestino
              </button>
            ))}
        </div>
      </div>
      <p className="muted small">
        File, mod e plugin eliminati, e le versioni sostituite da un caricamento, restano qui per 30 giorni; poi vengono
        cancellati definitivamente in automatico.
        {items.length > 0 && ` ${items.length} elementi, ${formatBytes(total)}.`}
      </p>

      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      {items.length === 0 ? (
        <p className="muted">Il cestino è vuoto.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Elemento</th>
                <th>Eliminato</th>
                <th>Cancellazione tra</th>
                <th>Dimensione</th>
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
                      {item.reason === 'replaced' && <span className="tag tag-accent"> versione sostituita</span>}
                    </div>
                    <div className="muted small mono">{origin(item)}</div>
                    {conflict?.id === item.id && (
                      <div className="btn-row">
                        <span className="small error-text">{conflict.message}.</span>
                        <button type="button" className="btn btn-warning btn-sm" onClick={() => restore(item, true)}>
                          Sostituisci {item.kind === 'mod' ? 'la versione installata' : 'quello attuale'}
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConflict(null)}>
                          Annulla
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="muted small">{formatDate(item.deletedAt)}</td>
                  <td>
                    <span className={daysClass(item.daysLeft)} title={`Cancellazione definitiva il ${formatDate(item.expiresAt)}`}>
                      {daysLabel(item.daysLeft)}
                    </span>
                  </td>
                  <td className="mono">{formatBytes(item.size)}</td>
                  <td>
                    <div className="btn-row nowrap">
                      <button type="button" className="btn btn-sm" disabled={actions.restore.isPending} onClick={() => restore(item)}>
                        Ripristina
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
                            Cancella per sempre
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>
                            Annulla
                          </button>
                        </>
                      ) : (
                        <button type="button" className="btn btn-danger-outline btn-sm" onClick={() => setConfirm(item.id)}>
                          Elimina
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

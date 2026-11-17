import { useState } from 'react'
import PageActions from '../components/PageActions'
import { errorMessage } from '../lib/api'
import { backupDownloadUrl, type BackupResult, type WorldBackup, useBackupActions, useBackups } from '../lib/backups'
import { useCurrentServer } from '../lib/currentServer'
import { formatBytes, formatDate } from '../lib/format'

/** Tempo trascorso, per "Ultimo backup: 3 ore fa". */
function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return 'adesso'
  if (minutes < 60) return minutes === 1 ? '1 minuto fa' : `${minutes} minuti fa`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours === 1 ? '1 ora fa' : `${hours} ore fa`
  const days = Math.round(hours / 24)
  return days === 1 ? 'ieri' : `${days} giorni fa`
}

export default function BackupsTab() {
  const server = useCurrentServer()
  const backups = useBackups(server.id)
  const { create, remove, restore } = useBackupActions(server.id)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [confirmRestore, setConfirmRestore] = useState<WorldBackup | null>(null)
  const [done, setDone] = useState<BackupResult | null>(null)
  const [restored, setRestored] = useState<{ backup: WorldBackup; trashed: string[] } | null>(null)
  const on = server.state !== 'stopped'

  const start = () => {
    setDone(null)
    setRestored(null)
    create.mutate(undefined, { onSuccess: setDone })
  }

  const doRestore = (backup: WorldBackup) => {
    setDone(null)
    setRestored(null)
    restore.mutate(backup.name, {
      onSuccess: (r) => setRestored({ backup, trashed: r.trashed }),
      onSettled: () => setConfirmRestore(null),
    })
  }

  if (backups.isLoading) return <div className="spinner" />
  if (backups.error || !backups.data) return <div className="alert alert-error">{errorMessage(backups.error)}</div>

  const { backups: list, schedule } = backups.data
  const last = list[0]

  return (
    <div className="stack">
      <PageActions>
        <button type="button" className="btn btn-primary" disabled={create.isPending} onClick={start}>
          {create.isPending ? (on ? 'Salvataggio del mondo…' : 'Backup in corso…') : 'Fai un backup ora'}
        </button>
      </PageActions>
      <div className="card">
        <dl className="stats">
          <div>
            <dt>Ultimo backup</dt>
            <dd>{last ? `${formatDate(last.createdAt)} (${ago(last.createdAt)})` : 'Mai'}</dd>
          </div>
          <div>
            <dt>Backup automatico</dt>
            <dd>{schedule.time ? `Ogni giorno alle ${schedule.time}` : 'Disattivato'}</dd>
          </div>
          <div>
            <dt>Prossimo</dt>
            <dd>{schedule.next ? formatDate(schedule.next) : '—'}</dd>
          </div>
        </dl>
        <p className="muted small">
          Ogni backup è uno .zip con il mondo{server.game === 'tmodloader' ? ' (.wld) e i dati delle mod (.twld)' : ' (.wld)'}.
          {on && ' Con il server acceso, prima del backup il mondo viene salvato.'} Dei backup automatici si tengono gli
          ultimi {schedule.keep}; quelli fatti a mano restano finché non li elimini. Per ripristinare un backup il server
          dev'essere spento.
          {schedule.time && ` Orario del server: ${schedule.timeZone}.`}
        </p>
      </div>

      {create.isError && <div className="alert alert-error">{errorMessage(create.error)}</div>}
      {done && (
        <div className={done.running && !done.saved ? 'alert alert-warning' : 'alert alert-success'}>
          Backup creato: <span className="mono">{done.backup.name}</span> ({formatBytes(done.backup.size)}).
          {done.running && !done.saved && ' Il server non ha confermato il salvataggio in tempo: contiene l\'ultimo salvataggio su disco.'}
        </div>
      )}
      {remove.isError && <div className="alert alert-error">{errorMessage(remove.error)}</div>}
      {restore.isError && <div className="alert alert-error">{errorMessage(restore.error)}</div>}
      {restored && (
        <div className="alert alert-success">
          Ripristinato il backup del {formatDate(restored.backup.createdAt)}.
          {restored.trashed.length > 0 && ` Il mondo che c'era (${restored.trashed.join(', ')}) è nel cestino del server.`} Al
          prossimo avvio il server apre il mondo ripristinato.
        </div>
      )}
      {confirmRestore && (
        <div className="alert alert-warning">
          <p>
            Ripristinare il backup del <strong>{formatDate(confirmRestore.createdAt)}</strong>? Il mondo attuale viene
            sostituito: finisce nel cestino del server, da cui si può recuperare per 30 giorni.
            {confirmRestore.files.length > 0 && ` Il backup contiene ${confirmRestore.files.join(', ')}.`}
          </p>
          {on && <p className="small"><strong>Spegni il server per ripristinare il backup.</strong></p>}
          <div className="btn-row">
            <button type="button" className="btn btn-warning btn-sm" disabled={on || restore.isPending} onClick={() => doRestore(confirmRestore)}>
              {restore.isPending ? 'Ripristino…' : 'Conferma il ripristino'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmRestore(null)}>
              Annulla
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <h2>Backup</h2>
        {list.length === 0 ? (
          <p className="muted">Nessun backup ancora.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>File</th>
                  <th>Dimensione</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((b) => (
                  <tr key={b.name}>
                    <td>
                      <strong>{formatDate(b.createdAt)}</strong>{' '}
                      <span className={b.auto ? 'tag' : 'tag tag-accent'}>{b.auto ? 'automatico' : 'manuale'}</span>
                    </td>
                    <td>
                      <div className="mono small">{b.name}</div>
                      {b.files.length > 0 && <div className="muted small">{b.files.join(', ')}</div>}
                    </td>
                    <td className="mono">{formatBytes(b.size)}</td>
                    <td>
                      <div className="btn-row nowrap">
                        <a className="btn btn-sm" href={backupDownloadUrl(server.id, b.name)} download>
                          Scarica
                        </a>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={on || restore.isPending}
                          title={on ? 'Spegni il server per ripristinare un backup' : 'Rimette questo mondo al posto di quello attuale'}
                          onClick={() => {
                            setRestored(null)
                            setConfirmRestore(b)
                          }}
                        >
                          Ripristina
                        </button>
                        {confirm === b.name ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              disabled={remove.isPending}
                              onClick={() => remove.mutate(b.name, { onSettled: () => setConfirm(null) })}
                            >
                              Conferma
                            </button>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>
                              Annulla
                            </button>
                          </>
                        ) : (
                          <button type="button" className="btn btn-danger-outline btn-sm" onClick={() => setConfirm(b.name)}>
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
    </div>
  )
}

import { useState } from 'react'
import PageActions from '../components/PageActions'
import { errorMessage } from '../lib/api'
import { backupDownloadUrl, type BackupResult, type WorldBackup, useBackupActions, useBackups } from '../lib/backups'
import { useCurrentServer } from '../lib/currentServer'
import { formatBytes, formatDate } from '../lib/format'
import { t, tn } from '../i18n'

/** Tempo trascorso, per "Ultimo backup: 3 ore fa". */
function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return t('just now')
  if (minutes < 60) return minutes === 1 ? t('1 minute ago') : t('{count} minutes ago', { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours === 1 ? t('1 hour ago') : t('{count} hours ago', { count: hours })
  const days = Math.round(hours / 24)
  return days === 1 ? t('yesterday') : t('{count} days ago', { count: days })
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
          {create.isPending ? (on ? t('Saving the world…') : t('Backing up…')) : t('Back up now')}
        </button>
      </PageActions>
      <div className="card">
        <dl className="stats">
          <div>
            <dt>{t('Last backup')}</dt>
            <dd>{last ? `${formatDate(last.createdAt)} (${ago(last.createdAt)})` : t('Never')}</dd>
          </div>
          <div>
            <dt>{t('Automatic backup')}</dt>
            <dd>{schedule.time ? t('Every day at {time}', { time: schedule.time }) : t('Off')}</dd>
          </div>
          <div>
            <dt>{t('Next')}</dt>
            <dd>{schedule.next ? formatDate(schedule.next) : '—'}</dd>
          </div>
        </dl>
        <p className="muted small">
          {server.game === 'tmodloader'
            ? t('Each backup is a .zip with the world (.wld) and the mod data (.twld).')
            : t('Each backup is a .zip with the world (.wld).')}
          {on && ` ${t('With the server running, the world is saved before the backup.')}`}{' '}
          {t(
            'The last {keep} automatic backups are kept; the manual ones stay until you delete them. To restore a backup the server must be stopped.',
            { keep: schedule.keep },
          )}
          {schedule.time && ` ${t('Server time zone: {zone}.', { zone: schedule.timeZone })}`}
        </p>
      </div>

      {create.isError && <div className="alert alert-error">{errorMessage(create.error)}</div>}
      {done && (
        <div className={done.running && !done.saved ? 'alert alert-warning' : 'alert alert-success'}>
          {tn('Backup created: {name} ({size}).', { name: <span className="mono">{done.backup.name}</span>, size: formatBytes(done.backup.size) })}
          {done.running && !done.saved && ` ${t('The server did not confirm the save in time: it contains the last save on disk.')}`}
        </div>
      )}
      {remove.isError && <div className="alert alert-error">{errorMessage(remove.error)}</div>}
      {restore.isError && <div className="alert alert-error">{errorMessage(restore.error)}</div>}
      {restored && (
        <div className="alert alert-success">
          {t('Restored the backup of {date}.', { date: formatDate(restored.backup.createdAt) })}
          {restored.trashed.length > 0 && ` ${t('The previous world ({files}) is in the server trash.', { files: restored.trashed.join(', ') })}`}{' '}
          {t('On the next start the server opens the restored world.')}
        </div>
      )}
      {confirmRestore && (
        <div className="alert alert-warning">
          <p>
            {tn(
              'Restore the backup of {date}? The current world is replaced: it goes to the server trash, where it can be recovered for 30 days.',
              { date: <strong>{formatDate(confirmRestore.createdAt)}</strong> },
            )}
            {confirmRestore.files.length > 0 && ` ${t('The backup contains {files}.', { files: confirmRestore.files.join(', ') })}`}
          </p>
          {on && <p className="small"><strong>{t('Stop the server to restore the backup.')}</strong></p>}
          <div className="btn-row">
            <button type="button" className="btn btn-warning btn-sm" disabled={on || restore.isPending} onClick={() => doRestore(confirmRestore)}>
              {restore.isPending ? t('Restoring…') : t('Confirm the restore')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmRestore(null)}>
              {t('Cancel')}
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <h2>{t('Backups')}</h2>
        {list.length === 0 ? (
          <p className="muted">{t('No backups yet.')}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('Date')}</th>
                  <th>{t('File')}</th>
                  <th>{t('Size')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((b) => (
                  <tr key={b.name}>
                    <td>
                      <strong>{formatDate(b.createdAt)}</strong>{' '}
                      <span className={b.auto ? 'tag' : 'tag tag-accent'}>{b.auto ? t('automatic') : t('manual')}</span>
                    </td>
                    <td>
                      <div className="mono small">{b.name}</div>
                      {b.files.length > 0 && <div className="muted small">{b.files.join(', ')}</div>}
                    </td>
                    <td className="mono">{formatBytes(b.size)}</td>
                    <td>
                      <div className="btn-row nowrap">
                        <a className="btn btn-sm" href={backupDownloadUrl(server.id, b.name)} download>
                          {t('Download')}
                        </a>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={on || restore.isPending}
                          title={on ? t('Stop the server to restore a backup') : t('Puts this world in place of the current one')}
                          onClick={() => {
                            setRestored(null)
                            setConfirmRestore(b)
                          }}
                        >
                          {t('Restore')}
                        </button>
                        {confirm === b.name ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              disabled={remove.isPending}
                              onClick={() => remove.mutate(b.name, { onSettled: () => setConfirm(null) })}
                            >
                              {t('Confirm')}
                            </button>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>
                              {t('Cancel')}
                            </button>
                          </>
                        ) : (
                          <button type="button" className="btn btn-danger-outline btn-sm" onClick={() => setConfirm(b.name)}>
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
    </div>
  )
}

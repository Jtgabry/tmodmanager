import { useState } from 'react'
import { errorMessage } from '../../lib/api'
import { formatBytes, formatDate } from '../../lib/format'
import type { ModUpdate, UpdateJob, UpdateJobItem, UpdateReport } from '../../lib/types'
import { itemFraction } from '../../lib/jobs'
import { isUpdatable, useRecheckUpdates } from '../../lib/workshop'
import { t } from '../../i18n'

const itemState = (state: UpdateJobItem['state']): { text: string; className: string } =>
  ({
    queued: { text: t('queued'), className: 'tag' },
    downloading: { text: t('downloading…'), className: 'tag tag-accent' },
    installing: { text: t('installing…'), className: 'tag tag-accent' },
    done: { text: t('done'), className: 'tag tag-used' },
    skipped: { text: t('already up to date'), className: 'tag' },
    error: { text: t('error'), className: 'tag tag-danger' },
    cancelled: { text: t('cancelled'), className: 'tag' },
  })[state]

const label = (u: ModUpdate) => u.displayName ?? u.name

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`

/** Contenuto della finestra "Aggiornamenti dal Workshop": riepilogo, "Aggiorna tutte" e avanzamento dell'aggiornamento. */
export default function WorkshopUpdates(props: {
  serverId: string
  report: UpdateReport | undefined
  loading: boolean
  error: unknown
  job: UpdateJob | null | undefined
  starting: boolean
  startError: unknown
  onUpdate: (names: string[]) => void
}) {
  const { serverId, report, job } = props
  const recheck = useRecheckUpdates(serverId)
  const [hiddenJob, setHiddenJob] = useState<string | null>(null)

  const updatable = report?.mods.filter(isUpdatable) ?? []
  const unlinked = report?.mods.filter((m) => m.status === 'unlinked') ?? []
  const incompatible = report?.mods.filter((m) => m.status === 'incompatible') ?? []
  const needsTml = report?.mods.filter((m) => m.newerRequiresTml) ?? []
  const showJob = job && job.startedAt !== hiddenJob

  return (
    <div className="stack">
      <div className="section-header">
        <span className="muted small">{report?.tmlVersion ? t('Server tModLoader: {version}', { version: report.tmlVersion }) : ''}</span>
        <div className="btn-row">
          {report?.steamcmd && updatable.length > 0 && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={props.starting}
              onClick={() => props.onUpdate(updatable.map((u) => u.name))}
            >
              {t('Update all ({count})', { count: updatable.length })}
            </button>
          )}
          <button type="button" className="btn btn-sm" disabled={recheck.isPending || props.loading} onClick={() => recheck.mutate()}>
            {recheck.isPending ? t('Checking…|updates') : t('Check again')}
          </button>
        </div>
      </div>

      {props.loading && <p className="muted">{t('Checking for updates on the Workshop…')}</p>}
      {(props.error || recheck.error) && <div className="alert alert-error">{errorMessage(recheck.error ?? props.error)}</div>}
      {props.startError ? <div className="alert alert-error">{errorMessage(props.startError)}</div> : null}

      {report && (
        <>
          {!report.steamcmd && (
            <div className="alert alert-warning">
              {t('You can see the updates but not download them from the panel: {problem}.', { problem: report.steamcmdProblem ?? '' })}
            </div>
          )}
          {!report.apiKey && (
            <p className="hint">
              {t(
                'Without a Steam Web API key you can only see whether a mod was updated on the Workshop after you installed it (not the version number), and mods must be linked by hand.',
              )}
            </p>
          )}

          {updatable.length === 0 ? (
            <p className="muted">
              {report.tmlVersion
                ? t('All the mods linked to the Workshop are up to date (for tModLoader {version}).', { version: report.tmlVersion })
                : t('All the mods linked to the Workshop are up to date.')}
            </p>
          ) : (
            <ul className="update-list">
              {updatable.map((u) => (
                <li key={u.name}>
                  <strong>{label(u)}</strong>{' '}
                  <span className="mono small">
                    v{u.installedVersion ?? '?'} → {u.latestVersion ? `v${u.latestVersion}` : t('newer version')}
                  </span>
                  {u.status === 'maybe' && <span className="muted small"> ({t('updated on the Workshop on {date}', { date: formatDate(u.timeUpdated) })})</span>}
                  {u.url && (
                    <>
                      {' · '}
                      <a href={u.url} target="_blank" rel="noreferrer noopener" className="small">
                        Workshop
                      </a>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          {needsTml.length > 0 && (
            <p className="hint">
              {t('Newer versions that require updating tModLoader (from Server management):')}{' '}
              {needsTml.map((u) => `${label(u)} v${u.newerVersion} (tModLoader ${u.newerRequiresTml})`).join(', ')}.
            </p>
          )}
          {incompatible.length > 0 && (
            <p className="hint">
              {t('There is no version for tModLoader {version} on the Workshop: {mods}.', { version: report.tmlVersion ?? '?', mods: incompatible.map(label).join(', ') })}
            </p>
          )}
          {unlinked.length > 0 && (
            <p className="hint">
              {t('Not linked to the Workshop: {mods}. You can link them by hand from the mod details.', { mods: unlinked.map(label).join(', ') })}
            </p>
          )}
          <p className="muted small">{t('Checked {date}.', { date: formatDate(report.checkedAt) })}</p>
        </>
      )}
      {showJob && <JobView job={job} onHide={() => setHiddenJob(job.startedAt)} />}
    </div>
  )
}

/** Avanzamento dell'ultimo lavoro di download: una riga per mod, avvisi e cosa fare dopo. */
export function JobView({ job, onHide }: { job: UpdateJob; onHide?: () => void }) {
  const running = job.state === 'running'
  const done = job.items.filter((i) => i.state === 'done')
  return (
    <div className="update-job">
      <div className="section-header">
        <h3>{running ? t('Downloading…') : job.state === 'error' ? t('Downloads finished with errors') : t('Downloads completed')}</h3>
        {!running && onHide && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onHide}>
            {t('Hide')}
          </button>
        )}
      </div>
      {running && job.items.every((i) => i.state === 'queued') && <p className="muted small">{t('Connecting to Steam…')}</p>}
      <ul className="update-items">
        {job.items.map((item) => (
          <ItemRow key={item.name} item={item} />
        ))}
      </ul>
      {job.warnings.map((w) => (
        <p key={w} className="hint">
          {w}
        </p>
      ))}
      {!running && done.some((i) => !i.install && i.from) && (
        <p className="small">{t('The previous versions stay in the version archive. Restart the server to use the updated mods.')}</p>
      )}
      {!running && done.some((i) => i.install) && (
        <p className="small">{t('The new mods are installed but not enabled yet: enable them all together with «Enable and restart».')}</p>
      )}
    </div>
  )
}

/** Una mod dell'aggiornamento: nome, versioni, barra di avanzamento e stato. */
function ItemRow({ item }: { item: UpdateJobItem }) {
  const fraction = itemFraction(item)
  const barClass =
    item.state === 'error'
      ? 'bar-error'
      : item.state === 'done'
        ? 'bar-done'
        : item.state === 'skipped' || item.state === 'cancelled'
          ? 'bar-skipped'
          : fraction === null || item.state === 'installing'
            ? 'indeterminate'
            : undefined
  return (
    <li className="update-item">
      <div className="update-item-name">
        <strong>{item.name}</strong>
        {item.dependency && <span className="muted small"> ({t('new dependency')})</span>}
        {item.install && <span className="muted small"> ({t('new')})</span>}
        <div className="mono small muted">
          {item.state === 'done' && item.to ? `${item.from ? `v${item.from} → ` : ''}v${item.to}` : item.from ? `v${item.from}` : ''}
        </div>
      </div>
      <div
        className="progress"
        role="progressbar"
        aria-label={t('Progress of {mod}', { mod: item.name })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
      >
        <div style={{ width: fraction === null ? '100%' : percent(fraction) }} className={barClass} />
      </div>
      <div className="update-item-status small">
        <span className={itemState(item.state).className}>{itemState(item.state).text}</span>
        {item.state === 'downloading' && (
          <span className="muted mono">
            {' '}
            {item.bytes == null
              ? t('waiting for data…')
              : `${formatBytes(item.bytes)}${item.totalBytes ? ` / ${formatBytes(item.totalBytes)} · ${percent(fraction ?? 0)}` : ''}`}
          </span>
        )}
        {item.state === 'queued' && item.totalBytes ? <span className="muted mono"> {formatBytes(item.totalBytes)}</span> : null}
      </div>
      {item.message && <div className={`update-item-message small ${item.state === 'error' ? 'error-text' : 'muted'}`}>{item.message}</div>}
    </li>
  )
}

import { useState } from 'react'
import { errorMessage } from '../../lib/api'
import { formatBytes, formatDate } from '../../lib/format'
import type { ModUpdate, UpdateJob, UpdateJobItem, UpdateReport } from '../../lib/types'
import { itemFraction } from '../../lib/jobs'
import { isUpdatable, useRecheckUpdates } from '../../lib/workshop'

const ITEM_STATE: Record<UpdateJobItem['state'], { text: string; className: string }> = {
  queued: { text: 'in coda', className: 'tag' },
  downloading: { text: 'download…', className: 'tag tag-accent' },
  installing: { text: 'installazione…', className: 'tag tag-accent' },
  done: { text: 'fatto', className: 'tag tag-used' },
  skipped: { text: 'già aggiornata', className: 'tag' },
  error: { text: 'errore', className: 'tag tag-danger' },
  cancelled: { text: 'annullato', className: 'tag' },
}

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
        <span className="muted small">{report?.tmlVersion ? `tModLoader del server: ${report.tmlVersion}` : ''}</span>
        <div className="btn-row">
          {report?.steamcmd && updatable.length > 0 && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={props.starting}
              onClick={() => props.onUpdate(updatable.map((u) => u.name))}
            >
              Aggiorna tutte ({updatable.length})
            </button>
          )}
          <button type="button" className="btn btn-sm" disabled={recheck.isPending || props.loading} onClick={() => recheck.mutate()}>
            {recheck.isPending ? 'Controllo…' : 'Ricontrolla'}
          </button>
        </div>
      </div>

      {props.loading && <p className="muted">Controllo degli aggiornamenti nel Workshop…</p>}
      {(props.error || recheck.error) && <div className="alert alert-error">{errorMessage(recheck.error ?? props.error)}</div>}
      {props.startError ? <div className="alert alert-error">{errorMessage(props.startError)}</div> : null}

      {report && (
        <>
          {!report.steamcmd && (
            <div className="alert alert-warning">
              Puoi vedere gli aggiornamenti ma non scaricarli dal pannello: {report.steamcmdProblem}.
            </div>
          )}
          {!report.apiKey && (
            <p className="hint">
              Senza chiave Steam Web API si vede solo se una mod è stata aggiornata nel Workshop dopo che l'hai installata
              (non il numero di versione), e le mod vanno collegate a mano.
            </p>
          )}

          {updatable.length === 0 ? (
            <p className="muted">
              Tutte le mod collegate al Workshop sono aggiornate
              {report.tmlVersion ? ` (per tModLoader ${report.tmlVersion})` : ''}.
            </p>
          ) : (
            <ul className="update-list">
              {updatable.map((u) => (
                <li key={u.name}>
                  <strong>{label(u)}</strong>{' '}
                  <span className="mono small">
                    v{u.installedVersion ?? '?'} → {u.latestVersion ? `v${u.latestVersion}` : 'versione più recente'}
                  </span>
                  {u.status === 'maybe' && <span className="muted small"> (aggiornata nel Workshop il {formatDate(u.timeUpdated)})</span>}
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
              Versioni più recenti che richiedono di aggiornare tModLoader (da Gestione server):{' '}
              {needsTml.map((u) => `${label(u)} v${u.newerVersion} (tModLoader ${u.newerRequiresTml})`).join(', ')}.
            </p>
          )}
          {incompatible.length > 0 && (
            <p className="hint">
              Nel Workshop non c'è una versione per tModLoader {report.tmlVersion ?? '?'}: {incompatible.map(label).join(', ')}.
            </p>
          )}
          {unlinked.length > 0 && (
            <p className="hint">
              Non collegate al Workshop: {unlinked.map(label).join(', ')}. Puoi collegarle a mano dai dettagli della mod.
            </p>
          )}
          <p className="muted small">Controllato {formatDate(report.checkedAt)}.</p>
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
        <h3>{running ? 'Download in corso…' : job.state === 'error' ? 'Download conclusi con errori' : 'Download completati'}</h3>
        {!running && onHide && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onHide}>
            Nascondi
          </button>
        )}
      </div>
      {running && job.items.every((i) => i.state === 'queued') && <p className="muted small">Collegamento a Steam…</p>}
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
        <p className="small">Le versioni precedenti restano nell'archivio delle versioni. Riavvia il server per usare le mod aggiornate.</p>
      )}
      {!running && done.some((i) => i.install) && (
        <p className="small">Le mod nuove sono installate ma non ancora abilitate: abilitale tutte insieme con «Abilita e riavvia».</p>
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
        {item.dependency && <span className="muted small"> (dipendenza nuova)</span>}
        {item.install && <span className="muted small"> (nuova)</span>}
        <div className="mono small muted">
          {item.state === 'done' && item.to ? `${item.from ? `v${item.from} → ` : ''}v${item.to}` : item.from ? `v${item.from}` : ''}
        </div>
      </div>
      <div
        className="progress"
        role="progressbar"
        aria-label={`Avanzamento di ${item.name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
      >
        <div style={{ width: fraction === null ? '100%' : percent(fraction) }} className={barClass} />
      </div>
      <div className="update-item-status small">
        <span className={ITEM_STATE[item.state].className}>{ITEM_STATE[item.state].text}</span>
        {item.state === 'downloading' && (
          <span className="muted mono">
            {' '}
            {item.bytes == null
              ? 'in attesa dei dati…'
              : `${formatBytes(item.bytes)}${item.totalBytes ? ` / ${formatBytes(item.totalBytes)} · ${percent(fraction ?? 0)}` : ''}`}
          </span>
        )}
        {item.state === 'queued' && item.totalBytes ? <span className="muted mono"> {formatBytes(item.totalBytes)}</span> : null}
      </div>
      {item.message && <div className={`update-item-message small ${item.state === 'error' ? 'error-text' : 'muted'}`}>{item.message}</div>}
    </li>
  )
}

import { useState } from 'react'
import { useAuth } from '../../auth/AuthContext'
import Sheet from '../../components/Sheet'
import { errorMessage } from '../../lib/api'
import { usePowerAction } from '../../lib/servers'
import type { ApplyPendingResult, Server, UpdateJob } from '../../lib/types'
import { useApplyPending, useDismissPending, usePendingMods, useUpdateJob } from '../../lib/workshop'
import { JobView } from './WorkshopUpdates'
import { t } from '../../i18n'

const FINISHED = ['done', 'skipped', 'error']

/**
 * Riquadro dei download dal Workshop: avanzamento della coda e mod nuove in attesa di essere abilitate.
 * Finiti i download, «Abilita e riavvia» le abilita tutte insieme e riavvia il server (se è acceso).
 */
export default function WorkshopQueue({ server }: { server: Server }) {
  const { can } = useAuth()
  const job = useUpdateJob(server.id)
  const pending = usePendingMods(server.id)
  const apply = useApplyPending(server.id)
  const dismiss = useDismissPending(server.id)
  const power = usePowerAction()
  const [showJob, setShowJob] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [result, setResult] = useState<ApplyPendingResult | null>(null)

  const waiting = pending.data ?? []
  const running = job.data?.state === 'running'
  const isOn = server.state !== 'stopped'
  const canRestart = isOn && can(server.id, 'power') && server.managed
  const playersOnline = isOn ? server.players.online : 0

  if (!running && waiting.length === 0 && !result && !apply.error) return null

  const onApply = () => {
    // Con giocatori connessi si chiede conferma: il riavvio li disconnette
    if (canRestart && playersOnline > 0 && !confirming) {
      setConfirming(true)
      return
    }
    setConfirming(false)
    setResult(null)
    apply.mutate(undefined, {
      onSuccess: (r) => {
        setResult(r)
        if (canRestart && r.enabled.length > 0) power.mutate({ id: server.id, action: 'restart' })
      },
    })
  }

  const label = canRestart ? t('Enable and restart') : t('Enable')

  return (
    <div className="workshop-queue">
      {running && job.data && <JobSummary job={job.data} onDetails={() => setShowJob(true)} />}

      {waiting.length > 0 && (
        <div className="workshop-queue-row">
          <div className="workshop-queue-text">
            <strong>
              {waiting.length === 1 ? t('1 new mod ready to enable') : t('{count} new mods ready to enable', { count: waiting.length })}
            </strong>
            <ul className="pending-list">
              {waiting.map((m) => (
                <li key={m.name} className="pending-chip">
                  <span>{m.displayName ?? m.name}</span>
                  <button
                    type="button"
                    className="pending-chip-remove"
                    aria-label={t('Do not enable {mod}', { mod: m.displayName ?? m.name })}
                    title={t('Do not enable it (it stays installed, disabled)')}
                    disabled={dismiss.isPending || apply.isPending}
                    onClick={() => dismiss.mutate(m.name)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            {running && <span className="muted small">{t('You can enable them when the downloads are finished.')}</span>}
            {!running && !canRestart && isOn && (
              <span className="muted small">{t('After enabling them, restart the server to load them.')}</span>
            )}
            {!isOn && <span className="muted small">{t('The server is stopped: they will be loaded on the next start.')}</span>}
            {confirming && (
              <span className="hint">
                {playersOnline === 1
                  ? t('There is 1 player connected: the restart disconnects them (the world is saved).')
                  : t('There are {count} players connected: the restart disconnects them (the world is saved).', { count: playersOnline })}
              </span>
            )}
          </div>
          <div className="btn-row">
            {confirming && (
              <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
                {t('Cancel')}
              </button>
            )}
            <button
              type="button"
              className={confirming ? 'btn btn-warning' : 'btn btn-primary'}
              disabled={running || apply.isPending || power.isPending || server.operation !== null}
              onClick={onApply}
            >
              {apply.isPending ? t('Enabling…') : confirming ? t('Confirm restart') : `${label} (${waiting.length})`}
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="workshop-queue-row">
          <div className="workshop-queue-text">
            {result.enabled.length > 0 && (
              <span className="small">
                {t('Enabled: {mods}.', { mods: result.enabled.join(', ') })}
                {canRestart ? (power.isPending || server.operation === 'restart' ? ` ${t('Restarting the server…')}` : '') : ''}
              </span>
            )}
            {result.failed.map((f) => (
              <span key={f.name} className="error-text small">
                {f.name}: {f.message}
              </span>
            ))}
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setResult(null)}>
            {t('Close')}
          </button>
        </div>
      )}

      {apply.error ? <div className="alert alert-error">{errorMessage(apply.error)}</div> : null}
      {dismiss.error ? <div className="alert alert-error">{errorMessage(dismiss.error)}</div> : null}
      {power.error ? <div className="alert alert-error">{errorMessage(power.error)}</div> : null}

      <Sheet open={showJob} title={t('Workshop downloads')} wide onClose={() => setShowJob(false)}>
        {job.data && <JobView job={job.data} />}
      </Sheet>
    </div>
  )
}

/** Riga compatta del lavoro in corso: quante mod sono finite e barra complessiva. */
function JobSummary({ job, onDetails }: { job: UpdateJob; onDetails: () => void }) {
  const finished = job.items.filter((i) => FINISHED.includes(i.state)).length
  const current = job.items.find((i) => i.state === 'downloading' || i.state === 'installing')
  const fraction = job.items.length ? finished / job.items.length : 0
  return (
    <div className="workshop-queue-row">
      <div className="workshop-queue-text">
        <strong>
          {t('Downloading: {done} of {total}', { done: finished, total: job.items.length })}
        </strong>
        <span className="muted small">
          {current
            ? current.state === 'installing'
              ? t('Installing {mod}…', { mod: current.name })
              : t('Downloading {mod}…', { mod: current.name })
            : t('Connecting to Steam…')}
        </span>
        <div className="progress" role="progressbar" aria-label={t('Download progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
          <div style={{ width: `${Math.max(fraction * 100, 3)}%` }} />
        </div>
      </div>
      <button type="button" className="btn btn-sm" onClick={onDetails}>
        {t('Details')}
      </button>
    </div>
  )
}

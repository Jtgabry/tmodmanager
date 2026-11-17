import { useState } from 'react'
import { useAuth } from '../../auth/AuthContext'
import Sheet from '../../components/Sheet'
import { errorMessage } from '../../lib/api'
import { usePowerAction } from '../../lib/servers'
import type { ApplyPendingResult, Server, UpdateJob } from '../../lib/types'
import { useApplyPending, useDismissPending, usePendingMods, useUpdateJob } from '../../lib/workshop'
import { JobView } from './WorkshopUpdates'

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

  const label = canRestart ? 'Abilita e riavvia' : 'Abilita'

  return (
    <div className="workshop-queue">
      {running && job.data && <JobSummary job={job.data} onDetails={() => setShowJob(true)} />}

      {waiting.length > 0 && (
        <div className="workshop-queue-row">
          <div className="workshop-queue-text">
            <strong>
              {waiting.length === 1 ? '1 mod nuova pronta' : `${waiting.length} mod nuove pronte`} da abilitare
            </strong>
            <ul className="pending-list">
              {waiting.map((m) => (
                <li key={m.name} className="pending-chip">
                  <span>{m.displayName ?? m.name}</span>
                  <button
                    type="button"
                    className="pending-chip-remove"
                    aria-label={`Non abilitare ${m.displayName ?? m.name}`}
                    title="Non abilitarla (resta installata, disabilitata)"
                    disabled={dismiss.isPending || apply.isPending}
                    onClick={() => dismiss.mutate(m.name)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            {running && <span className="muted small">Potrai abilitarle quando i download saranno finiti.</span>}
            {!running && !canRestart && isOn && (
              <span className="muted small">Dopo averle abilitate riavvia il server per caricarle.</span>
            )}
            {!isOn && <span className="muted small">Il server è spento: verranno caricate alla prossima accensione.</span>}
            {confirming && (
              <span className="hint">
                {playersOnline === 1 ? 'C\'è 1 giocatore connesso' : `Ci sono ${playersOnline} giocatori connessi`}: il riavvio li
                disconnette (il mondo viene salvato).
              </span>
            )}
          </div>
          <div className="btn-row">
            {confirming && (
              <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
                Annulla
              </button>
            )}
            <button
              type="button"
              className={confirming ? 'btn btn-warning' : 'btn btn-primary'}
              disabled={running || apply.isPending || power.isPending || server.operation !== null}
              onClick={onApply}
            >
              {apply.isPending ? 'Abilitazione…' : confirming ? 'Conferma riavvio' : `${label} (${waiting.length})`}
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="workshop-queue-row">
          <div className="workshop-queue-text">
            {result.enabled.length > 0 && (
              <span className="small">
                Abilitate: {result.enabled.join(', ')}.
                {canRestart ? (power.isPending || server.operation === 'restart' ? ' Riavvio del server…' : '') : ''}
              </span>
            )}
            {result.failed.map((f) => (
              <span key={f.name} className="error-text small">
                {f.name}: {f.message}
              </span>
            ))}
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setResult(null)}>
            Chiudi
          </button>
        </div>
      )}

      {apply.error ? <div className="alert alert-error">{errorMessage(apply.error)}</div> : null}
      {dismiss.error ? <div className="alert alert-error">{errorMessage(dismiss.error)}</div> : null}
      {power.error ? <div className="alert alert-error">{errorMessage(power.error)}</div> : null}

      <Sheet open={showJob} title="Download dal Workshop" wide onClose={() => setShowJob(false)}>
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
          Download in corso: {finished} di {job.items.length}
        </strong>
        <span className="muted small">
          {current ? `${current.state === 'installing' ? 'Installazione' : 'Download'} di ${current.name}…` : 'Collegamento a Steam…'}
        </span>
        <div className="progress" role="progressbar" aria-label="Avanzamento dei download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
          <div style={{ width: `${Math.max(fraction * 100, 3)}%` }} />
        </div>
      </div>
      <button type="button" className="btn btn-sm" onClick={onDetails}>
        Dettagli
      </button>
    </div>
  )
}

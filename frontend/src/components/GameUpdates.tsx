import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAdminServerActions, useGameUpdates } from '../lib/admin'
import { errorMessage } from '../lib/api'
import { GAME_LABEL, type SwitchJob, type UpdateNotice } from '../lib/types'

/**
 * Avvisi per gli amministratori dal controllo giornaliero degli aggiornamenti (fatto dall'agent al
 * massimo una volta al giorno): nuove versioni da installare, Terraria uscito prima di TShock (con il
 * passaggio temporaneo a vanilla) e ritorno su TShock quando arriva. Ogni avviso si può nascondere.
 */

const DISMISSED_KEY = 'tmm.dismissedUpdates'

function readDismissed(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as unknown
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function useDismissed() {
  const [dismissed, setDismissed] = useState(readDismissed)
  const dismiss = (id: string) => {
    const next = [...dismissed.filter((d) => d !== id), id].slice(-50)
    setDismissed(next)
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
    } catch {
      // senza localStorage resta nascosto solo fino al prossimo caricamento
    }
  }
  return { isDismissed: (id: string) => dismissed.includes(id), dismiss }
}

const names = (servers: { name: string }[]) => servers.map((s) => s.name).join(', ')

export default function GameUpdates() {
  const updates = useGameUpdates(true)
  const { isDismissed, dismiss } = useDismissed()
  if (!updates.data) return null

  const switches = updates.data.switches.filter((s) => !isDismissed(switchId(s)))
  const notices = updates.data.notices.filter((n) => !isDismissed(n.id))
  if (!switches.length && !notices.length) return null

  return (
    <div className="stack game-updates">
      {switches.map((job) => (
        <SwitchProgress key={switchId(job)} job={job} onClose={() => dismiss(switchId(job))} />
      ))}
      {notices.map((notice) => (
        <Notice key={notice.id} notice={notice} switches={updates.data.switches} onDismiss={() => dismiss(notice.id)} />
      ))}
    </div>
  )
}

const switchId = (job: SwitchJob) => `switch:${job.serverId}:${job.startedAt}`

function SwitchProgress({ job, onClose }: { job: SwitchJob; onClose: () => void }) {
  const running = job.phase !== 'done' && job.phase !== 'error'
  return (
    <div className={`alert ${job.phase === 'error' ? 'alert-error' : running ? 'alert-info' : 'alert-success'}`} role="status">
      <p>
        {running && <strong>{job.serverName} → {GAME_LABEL[job.to]}: </strong>}
        {job.message}
        {job.error && <> — {job.error}</>}
      </p>
      {running && <div className="progress progress-indeterminate"><div /></div>}
      {!running && (
        <div className="btn-row">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Chiudi
          </button>
        </div>
      )}
    </div>
  )
}

function Notice({ notice, switches, onDismiss }: { notice: UpdateNotice; switches: SwitchJob[]; onDismiss: () => void }) {
  const busy = (id: string) => switches.some((s) => s.serverId === id && s.phase !== 'done' && s.phase !== 'error')
  if (notice.type === 'update') return <UpdateAvailable notice={notice} onDismiss={onDismiss} />
  if (notice.type === 'tshock-behind') {
    const servers = notice.servers.filter((s) => !busy(s.id))
    return servers.length ? <TshockBehind notice={{ ...notice, servers }} onDismiss={onDismiss} /> : null
  }
  return busy(notice.server.id) ? null : <TshockReady notice={notice} onDismiss={onDismiss} />
}

function UpdateAvailable({ notice, onDismiss }: { notice: Extract<UpdateNotice, { type: 'update' }>; onDismiss: () => void }) {
  const { updateTml } = useAdminServerActions()
  const [confirm, setConfirm] = useState(false)
  const label = GAME_LABEL[notice.game]
  const forTerraria = notice.game !== 'terraria' && notice.gameVersion ? ` (per Terraria ${notice.gameVersion})` : ''

  if (updateTml.isSuccess) {
    return (
      <div className="alert alert-info">
        Aggiornamento di {label} alla {notice.to} avviato. L'avanzamento è in <Link to="/admin/servers">Gestione server</Link>.
      </div>
    )
  }

  return (
    <div className="alert alert-info">
      <p>
        È disponibile <strong>{label} {notice.to}</strong>
        {forTerraria} — installata la {notice.from ?? '?'}
        {notice.servers.length > 0 ? `, usata da ${names(notice.servers)}` : ', nessun server la usa'}.{' '}
        {notice.url && (
          <a href={notice.url} target="_blank" rel="noreferrer">
            Note di rilascio
          </a>
        )}
      </p>
      {confirm && (
        <p className="small">
          {notice.servers.length > 0
            ? 'I server accesi che la usano vengono spenti (salvando il mondo) e riaccesi alla fine. '
            : ''}
          {notice.game === 'tmodloader'
            ? 'Le mod potrebbero richiedere un aggiornamento per la nuova versione.'
            : 'I giocatori devono avere la stessa versione di Terraria del server per entrare.'}
        </p>
      )}
      <div className="btn-row">
        {confirm ? (
          <>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={updateTml.isPending}
              onClick={() => updateTml.mutate({ id: notice.installation, version: notice.to, restartServers: true })}
            >
              Conferma aggiornamento
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(false)}>
              Annulla
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setConfirm(true)}>
              Aggiorna {label}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}>
              Nascondi
            </button>
          </>
        )}
      </div>
      {updateTml.isError && <p className="error-text">{errorMessage(updateTml.error)}</p>}
    </div>
  )
}

function TshockBehind({ notice, onDismiss }: { notice: Extract<UpdateNotice, { type: 'tshock-behind' }>; onDismiss: () => void }) {
  const { switchGame } = useAdminServerActions()
  const [confirm, setConfirm] = useState<string | null>(null)
  const target = notice.servers.find((s) => s.id === confirm)

  return (
    <div className="alert alert-warning">
      <p>
        È uscito <strong>Terraria {notice.terrariaVersion}</strong>, ma TShock supporta ancora Terraria{' '}
        {notice.tshockGameVersion ?? '?'}: chi ha già aggiornato il gioco non può entrare in {names(notice.servers)}.
      </p>
      <p className="small">
        Nel frattempo puoi passare il server a Terraria vanilla {notice.terrariaVersion}. Mondo, dati di TShock e plugin
        restano dove sono (i plugin non sono attivi finché il server è vanilla), e quando esce TShock aggiornato qui
        compare il pulsante per tornarci.
      </p>
      {target && (
        <p className="small">
          <strong>{target.name}</strong>, se acceso, viene spento salvando il mondo e riacceso su vanilla. Se usi i
          personaggi salvati sul server (SSC di TShock), su vanilla ognuno entra con il suo personaggio locale.
        </p>
      )}
      <div className="btn-row">
        {target ? (
          <>
            <button
              type="button"
              className="btn btn-warning btn-sm"
              disabled={switchGame.isPending}
              onClick={() => switchGame.mutate({ id: target.id, game: 'terraria' }, { onSettled: () => setConfirm(null) })}
            >
              Conferma: passa a Terraria {notice.terrariaVersion}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>
              Annulla
            </button>
          </>
        ) : (
          <>
            {notice.servers.map((s) => (
              <button key={s.id} type="button" className="btn btn-warning btn-sm" onClick={() => setConfirm(s.id)}>
                Passa {notice.servers.length > 1 ? `«${s.name}» ` : ''}a Terraria {notice.terrariaVersion}
              </button>
            ))}
            <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}>
              Nascondi
            </button>
          </>
        )}
      </div>
      {switchGame.isError && <p className="error-text">{errorMessage(switchGame.error)}</p>}
    </div>
  )
}

function TshockReady({ notice, onDismiss }: { notice: Extract<UpdateNotice, { type: 'tshock-ready' }>; onDismiss: () => void }) {
  const { switchGame, stayVanilla } = useAdminServerActions()
  const [confirm, setConfirm] = useState(false)

  return (
    <div className="alert alert-success">
      <p>
        <strong>TShock {notice.tshockVersion}</strong> supporta Terraria {notice.tshockGameVersion}:{' '}
        <strong>{notice.server.name}</strong> può tornare su TShock, con i suoi dati e plugin.
      </p>
      {confirm && (
        <p className="small">
          {notice.needsUpdate && `Prima viene installata TShock ${notice.tshockVersion} (gli altri server TShock accesi vengono riavviati). `}
          Il server, se acceso, viene spento salvando il mondo e riacceso su TShock.
        </p>
      )}
      <div className="btn-row">
        {confirm ? (
          <>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={switchGame.isPending}
              onClick={() => switchGame.mutate({ id: notice.server.id, game: 'tshock' }, { onSettled: () => setConfirm(false) })}
            >
              Conferma: torna su TShock
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(false)}>
              Annulla
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setConfirm(true)}>
              Riporta su TShock
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={stayVanilla.isPending}
              title="Non proporlo più per questo server"
              onClick={() => stayVanilla.mutate(notice.server.id, { onSuccess: onDismiss })}
            >
              Resta su vanilla
            </button>
          </>
        )}
      </div>
      {(switchGame.isError || stayVanilla.isError) && <p className="error-text">{errorMessage(switchGame.error ?? stayVanilla.error)}</p>}
    </div>
  )
}

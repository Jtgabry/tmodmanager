import { useState } from 'react'
import { errorMessage } from '../lib/api'
import { usePowerAction } from '../lib/servers'
import type { PowerAction, Server } from '../lib/types'
import { IconPlay, IconRestart, IconStop } from './icons'

const CONFIRM: Partial<Record<PowerAction, string>> = {
  stop: 'Spegnere il server? I giocatori connessi verranno disconnessi (il mondo viene salvato).',
  restart: 'Riavviare il server? I giocatori connessi verranno disconnessi (il mondo viene salvato).',
}

/**
 * Pulsanti di accensione. `tile`: variante compatta della scheda server nella sidebar
 * (icona sopra, etichetta corta sotto).
 */
export default function PowerButtons({ server, variant = 'default' }: { server: Server; variant?: 'default' | 'tile' }) {
  const tile = variant === 'tile'
  const power = usePowerAction()
  const [pending, setPending] = useState<PowerAction | null>(null)
  const busy = server.operation !== null || power.isPending
  const isOn = server.state !== 'stopped'

  const run = (action: PowerAction) => {
    if (CONFIRM[action] && pending !== action) {
      setPending(action)
      return
    }
    setPending(null)
    power.mutate({ id: server.id, action })
  }

  return (
    <div className={tile ? 'power power-tile' : 'power'}>
      <div className="btn-row">
        {!isOn && (
          <button type="button" className="btn btn-success" disabled={busy} onClick={() => run('start')}>
            <IconPlay />
            Avvia
          </button>
        )}
        {isOn && (
          <>
            <button
              type="button"
              className={`btn ${pending === 'restart' ? 'btn-warning' : ''}`}
              disabled={busy || !server.managed}
              onClick={() => run('restart')}
            >
              <IconRestart />
              {pending === 'restart' ? (tile ? 'Conferma' : 'Conferma riavvio') : 'Riavvia'}
            </button>
            <button
              type="button"
              className={`btn ${pending === 'stop' ? 'btn-danger' : 'btn-danger-outline'}`}
              disabled={busy || !server.managed}
              onClick={() => run('stop')}
            >
              <IconStop />
              {pending === 'stop' ? (tile ? 'Conferma' : 'Conferma spegnimento') : 'Spegni'}
            </button>
          </>
        )}
        {pending && (
          <button type="button" className="btn btn-ghost" onClick={() => setPending(null)}>
            Annulla
          </button>
        )}
      </div>
      {pending && CONFIRM[pending] && <p className="hint">{CONFIRM[pending]}</p>}
      {isOn && !server.managed && (
        <p className="hint">Avviato fuori dalla sessione screen gestita: spegnilo a mano per poterlo controllare da qui.</p>
      )}
      {power.isError && <p className="error-text">{errorMessage(power.error)}</p>}
    </div>
  )
}

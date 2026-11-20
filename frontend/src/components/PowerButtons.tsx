import { useState } from 'react'
import { errorMessage } from '../lib/api'
import { usePowerAction } from '../lib/servers'
import type { PowerAction, Server } from '../lib/types'
import { IconPlay, IconRestart, IconStop } from './icons'
import { t } from '../i18n'

const confirmText = (action: PowerAction): string | undefined =>
  ({
    stop: t('Stop the server? Connected players will be disconnected (the world is saved).'),
    restart: t('Restart the server? Connected players will be disconnected (the world is saved).'),
  })[action as 'stop' | 'restart']

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
    if (confirmText(action) && pending !== action) {
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
            {t('Start')}
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
              {pending === 'restart' ? (tile ? t('Confirm') : t('Confirm restart')) : t('Restart')}
            </button>
            <button
              type="button"
              className={`btn ${pending === 'stop' ? 'btn-danger' : 'btn-danger-outline'}`}
              disabled={busy || !server.managed}
              onClick={() => run('stop')}
            >
              <IconStop />
              {pending === 'stop' ? (tile ? t('Confirm') : t('Confirm stop')) : t('Stop')}
            </button>
          </>
        )}
        {pending && (
          <button type="button" className="btn btn-ghost" onClick={() => setPending(null)}>
            {t('Cancel')}
          </button>
        )}
      </div>
      {pending && confirmText(pending) && <p className="hint">{confirmText(pending)}</p>}
      {isOn && !server.managed && (
        <p className="hint">{t('Started outside the managed screen session: stop it by hand to control it from here.')}</p>
      )}
      {power.isError && <p className="error-text">{errorMessage(power.error)}</p>}
    </div>
  )
}

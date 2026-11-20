import { type ReactNode, useState } from 'react'
import { errorMessage } from '../../lib/api'
import type { WorldBoss, WorldSettingsChange, WorldSettingsState } from '../../lib/types'
import { useChangeWorldSettings, useWorldSettings } from '../../lib/worldEditor'

const TIMES = [
  { label: 'Alba', clock: 270 },
  { label: 'Mezzogiorno', clock: 720 },
  { label: 'Tramonto', clock: 1170 },
  { label: 'Mezzanotte', clock: 0 },
]

const MOON_PHASES = ['Luna piena', 'Gibbosa calante', 'Ultimo quarto', 'Falce calante', 'Luna nuova', 'Falce crescente', 'Primo quarto', 'Gibbosa crescente']

const GAME_MODES = ['Classica', 'Esperto', 'Maestro']

/** In ordine di progressione. wallOfFlesh segue l'hardmode (non si cambia da qui). */
const BOSSES: { key: WorldBoss; label: string }[] = [
  { key: 'slimeKing', label: 'Re Slime' },
  { key: 'eyeOfCthulhu', label: 'Occhio di Cthulhu' },
  { key: 'evilBoss', label: 'Mangiatore di mondi / Cervello di Cthulhu' },
  { key: 'queenBee', label: 'Ape regina' },
  { key: 'skeletron', label: 'Skeletron' },
  { key: 'deerclops', label: 'Deerclops' },
  { key: 'wallOfFlesh', label: 'Muro di carne' },
  { key: 'queenSlime', label: 'Regina Slime' },
  { key: 'destroyer', label: 'Il Distruttore' },
  { key: 'twins', label: 'I Gemelli' },
  { key: 'skeletronPrime', label: 'Skeletron Primo' },
  { key: 'plantera', label: 'Plantera' },
  { key: 'golem', label: 'Golem' },
  { key: 'dukeFishron', label: 'Duca Pescedrago' },
  { key: 'empressOfLight', label: 'Imperatrice della luce' },
  { key: 'lunaticCultist', label: 'Cultista lunatico' },
  { key: 'moonLord', label: 'Signore della luna' },
]

const pad = (n: number) => String(n).padStart(2, '0')
const formatClock = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`

/**
 * Settaggi del mondo a server acceso (mod LiveMap): ora, meteo, eventi, luna, difficoltà, hardmode, spawn, boss
 * sconfitti. Valgono subito per chi è connesso; si salvano col mondo.
 */
export default function WorldSettingsCard({ serverId, onPickSpawn }: { serverId: string; onPickSpawn: () => void }) {
  const query = useWorldSettings(serverId, true)
  const change = useChangeWorldSettings(serverId)
  const [confirmHardMode, setConfirmHardMode] = useState(false)
  const [clockText, setClockText] = useState('')

  if (query.isLoading) return null
  if (query.error || !query.data) return <div className="alert alert-error">{errorMessage(query.error)}</div>
  const s: WorldSettingsState = query.data
  const set = (c: WorldSettingsChange) => change.mutate(c)
  const busy = change.isPending
  const journey = s.gameMode === 3
  const lastFailures = change.data?.failures ?? []

  return (
    <div className="card stack">
      <div className="section-header">
        <h2>Impostazioni del mondo</h2>
        <span className="small muted">Valgono subito per chi è connesso, e restano col salvataggio del mondo.</span>
      </div>

      <div className="world-settings">
        <Row label="Ora">
          <span className="mono world-settings-value">
            {formatClock(s.clock)} · {s.day ? 'giorno' : 'notte'}
          </span>
          <div className="btn-row">
            {TIMES.map((t) => (
              <button key={t.label} type="button" className="btn btn-sm" disabled={busy} onClick={() => set({ clock: t.clock })}>
                {t.label}
              </button>
            ))}
          </div>
          <form
            className="form-inline"
            onSubmit={(e) => {
              e.preventDefault()
              const [h, m] = clockText.split(':').map(Number)
              if (Number.isInteger(h) && Number.isInteger(m)) set({ clock: h * 60 + m })
            }}
          >
            <input type="time" value={clockText} onChange={(e) => setClockText(e.target.value)} aria-label="Ora precisa" />
            <button type="submit" className="btn btn-sm" disabled={busy || !clockText}>
              Imposta
            </button>
          </form>
        </Row>

        <Row label="Meteo">
          <Toggle on={s.rain} disabled={busy} onClick={() => set({ rain: !s.rain })}>
            Pioggia
          </Toggle>
          <Toggle on={s.sandstorm} disabled={busy} onClick={() => set({ sandstorm: !s.sandstorm })}>
            Tempesta di sabbia
          </Toggle>
        </Row>

        <Row label="Eventi">
          <Toggle on={s.bloodMoon} disabled={busy || (s.day && !s.bloodMoon)} title={s.day ? 'Solo di notte' : undefined} onClick={() => set({ bloodMoon: !s.bloodMoon })}>
            Luna di sangue
          </Toggle>
          <Toggle on={s.eclipse} disabled={busy || (!s.day && !s.eclipse)} title={s.day ? undefined : 'Solo di giorno'} onClick={() => set({ eclipse: !s.eclipse })}>
            Eclissi solare
          </Toggle>
        </Row>

        <Row label="Luna">
          <select value={s.moonPhase} disabled={busy} onChange={(e) => set({ moonPhase: Number(e.target.value) })} aria-label="Fase lunare">
            {MOON_PHASES.map((name, i) => (
              <option key={name} value={i}>
                {name}
              </option>
            ))}
          </select>
        </Row>

        <Row label="Difficoltà">
          {journey ? (
            <span className="small muted">Viaggio: un mondo Viaggio non si può cambiare.</span>
          ) : (
            <div className="segmented" role="group" aria-label="Difficoltà">
              {GAME_MODES.map((name, i) => (
                <button key={name} type="button" className={s.gameMode === i ? 'active' : ''} disabled={busy} onClick={() => s.gameMode !== i && set({ gameMode: i })}>
                  {name}
                </button>
              ))}
            </div>
          )}
        </Row>

        <Row label="Hardmode">
          <span className="world-settings-value">{s.generatingHardMode ? 'In generazione…' : s.hardMode ? 'Attivo' : 'Non attivo'}</span>
          {s.hardMode ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              title="Toglie solo lo stato: consacrato, corruzione/cremisi e minerali già generati restano"
              onClick={() => set({ hardMode: false })}
            >
              Disattiva
            </button>
          ) : confirmHardMode ? (
            <>
              <span className="small">Come sconfiggere il Muro di carne: genera consacrato e corruzione/cremisi nel mondo, non si torna indietro.</span>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={busy}
                onClick={() => {
                  setConfirmHardMode(false)
                  set({ hardMode: true })
                }}
              >
                Attiva comunque
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmHardMode(false)}>
                Annulla
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirmHardMode(true)}>
              Attiva…
            </button>
          )}
        </Row>

        <Row label="Spawn">
          <span className="mono world-settings-value">
            {s.spawnX}, {s.spawnY}
          </span>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={onPickSpawn}>
            Scegli sulla mappa
          </button>
        </Row>

        <Row label="Boss sconfitti">
          <div className="tag-filters">
            {BOSSES.map((b) => {
              const down = b.key === 'wallOfFlesh' ? s.hardMode : Boolean(s.bosses[b.key])
              return (
                <Toggle
                  key={b.key}
                  on={down}
                  disabled={busy || b.key === 'wallOfFlesh'}
                  title={b.key === 'wallOfFlesh' ? "Segue l'hardmode" : undefined}
                  onClick={() => b.key !== 'wallOfFlesh' && set({ bosses: { [b.key]: !down } })}
                >
                  {b.label}
                </Toggle>
              )
            })}
          </div>
        </Row>
      </div>

      {change.error ? <div className="alert alert-error">{errorMessage(change.error)}</div> : null}
      {lastFailures.length > 0 && (
        <div className="alert alert-warning">
          Non cambiato: {lastFailures.map((f) => f.reason).join(', ')}.
        </div>
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="world-settings-label">{label}</span>
      <div className="world-settings-controls">{children}</div>
    </>
  )
}

function Toggle({ on, disabled, title, onClick, children }: { on: boolean; disabled?: boolean; title?: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={on ? 'tag-filter active' : 'tag-filter'} aria-pressed={on} disabled={disabled} title={title} onClick={onClick}>
      {children}
    </button>
  )
}

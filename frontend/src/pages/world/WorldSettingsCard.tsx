import { type ReactNode, useState } from 'react'
import { errorMessage } from '../../lib/api'
import type { WorldBoss, WorldSettingsChange, WorldSettingsState } from '../../lib/types'
import { useChangeWorldSettings, useWorldSettings } from '../../lib/worldEditor'
import { t } from '../../i18n'

const times = () => [
  { label: t('Dawn'), clock: 270 },
  { label: t('Noon'), clock: 720 },
  { label: t('Dusk'), clock: 1170 },
  { label: t('Midnight'), clock: 0 },
]

const moonPhases = () => [
  t('Full moon'),
  t('Waning gibbous'),
  t('Third quarter'),
  t('Waning crescent'),
  t('New moon'),
  t('Waxing crescent'),
  t('First quarter'),
  t('Waxing gibbous'),
]

const gameModes = () => [t('Classic'), t('Expert'), t('Master')]

/** In ordine di progressione. wallOfFlesh segue l'hardmode (non si cambia da qui). */
const bosses = (): { key: WorldBoss; label: string }[] => [
  { key: 'slimeKing', label: t('King Slime') },
  { key: 'eyeOfCthulhu', label: t('Eye of Cthulhu') },
  { key: 'evilBoss', label: t('Eater of Worlds / Brain of Cthulhu') },
  { key: 'queenBee', label: t('Queen Bee') },
  { key: 'skeletron', label: 'Skeletron' },
  { key: 'deerclops', label: 'Deerclops' },
  { key: 'wallOfFlesh', label: t('Wall of Flesh') },
  { key: 'queenSlime', label: t('Queen Slime') },
  { key: 'destroyer', label: t('The Destroyer') },
  { key: 'twins', label: t('The Twins') },
  { key: 'skeletronPrime', label: t('Skeletron Prime') },
  { key: 'plantera', label: 'Plantera' },
  { key: 'golem', label: 'Golem' },
  { key: 'dukeFishron', label: t('Duke Fishron') },
  { key: 'empressOfLight', label: t('Empress of Light') },
  { key: 'lunaticCultist', label: t('Lunatic Cultist') },
  { key: 'moonLord', label: t('Moon Lord') },
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
        <h2>{t('World settings')}</h2>
        <span className="small muted">{t('They apply right away for whoever is connected, and stay with the world save.')}</span>
      </div>

      <div className="world-settings">
        <Row label={t('Time')}>
          <span className="mono world-settings-value">
            {formatClock(s.clock)} · {s.day ? t('day') : t('night')}
          </span>
          <div className="btn-row">
            {times().map((time) => (
              <button key={time.label} type="button" className="btn btn-sm" disabled={busy} onClick={() => set({ clock: time.clock })}>
                {time.label}
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
            <input type="time" value={clockText} onChange={(e) => setClockText(e.target.value)} aria-label={t('Exact time')} />
            <button type="submit" className="btn btn-sm" disabled={busy || !clockText}>
              {t('Set')}
            </button>
          </form>
        </Row>

        <Row label={t('Weather')}>
          <Toggle on={s.rain} disabled={busy} onClick={() => set({ rain: !s.rain })}>
            {t('Rain')}
          </Toggle>
          <Toggle on={s.sandstorm} disabled={busy} onClick={() => set({ sandstorm: !s.sandstorm })}>
            {t('Sandstorm')}
          </Toggle>
        </Row>

        <Row label={t('Events')}>
          <Toggle on={s.bloodMoon} disabled={busy || (s.day && !s.bloodMoon)} title={s.day ? t('Only at night') : undefined} onClick={() => set({ bloodMoon: !s.bloodMoon })}>
            {t('Blood Moon')}
          </Toggle>
          <Toggle on={s.eclipse} disabled={busy || (!s.day && !s.eclipse)} title={s.day ? undefined : t('Only during the day')} onClick={() => set({ eclipse: !s.eclipse })}>
            {t('Solar Eclipse')}
          </Toggle>
        </Row>

        <Row label={t('Moon')}>
          <select value={s.moonPhase} disabled={busy} onChange={(e) => set({ moonPhase: Number(e.target.value) })} aria-label={t('Moon phase')}>
            {moonPhases().map((name, i) => (
              <option key={name} value={i}>
                {name}
              </option>
            ))}
          </select>
        </Row>

        <Row label={t('Difficulty')}>
          {journey ? (
            <span className="small muted">{t('Journey: a Journey world cannot be changed.')}</span>
          ) : (
            <div className="segmented" role="group" aria-label={t('Difficulty')}>
              {gameModes().map((name, i) => (
                <button key={name} type="button" className={s.gameMode === i ? 'active' : ''} disabled={busy} onClick={() => s.gameMode !== i && set({ gameMode: i })}>
                  {name}
                </button>
              ))}
            </div>
          )}
        </Row>

        <Row label="Hardmode">
          <span className="world-settings-value">{s.generatingHardMode ? t('Generating…') : s.hardMode ? t('Active') : t('Not active')}</span>
          {s.hardMode ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              title={t('Only removes the state: hallow, corruption/crimson and ores already generated stay')}
              onClick={() => set({ hardMode: false })}
            >
              {t('Deactivate')}
            </button>
          ) : confirmHardMode ? (
            <>
              <span className="small">{t('Like defeating the Wall of Flesh: it generates hallow and corruption/crimson in the world, there is no going back.')}</span>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={busy}
                onClick={() => {
                  setConfirmHardMode(false)
                  set({ hardMode: true })
                }}
              >
                {t('Activate anyway')}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmHardMode(false)}>
                {t('Cancel')}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirmHardMode(true)}>
              {t('Activate…')}
            </button>
          )}
        </Row>

        <Row label="Spawn">
          <span className="mono world-settings-value">
            {s.spawnX}, {s.spawnY}
          </span>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={onPickSpawn}>
            {t('Pick on the map')}
          </button>
        </Row>

        <Row label={t('Defeated bosses')}>
          <div className="tag-filters">
            {bosses().map((b) => {
              const down = b.key === 'wallOfFlesh' ? s.hardMode : Boolean(s.bosses[b.key])
              return (
                <Toggle
                  key={b.key}
                  on={down}
                  disabled={busy || b.key === 'wallOfFlesh'}
                  title={b.key === 'wallOfFlesh' ? t('Follows hardmode') : undefined}
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
          {t('Not changed: {reasons}.', { reasons: lastFailures.map((f) => f.reason).join(', ') })}
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

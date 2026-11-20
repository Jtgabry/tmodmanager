import { type FormEvent, type ReactNode, useState } from 'react'
import { PickedHint } from '../../components/InstallationPicker'
import { useInstallationPicker } from '../../lib/installationPicker'
import { olderThanWorld, useAdminServerActions, useServerDefaults, useServerSettings, worldVersionLabel } from '../../lib/admin'
import { errorMessage, fieldErrors } from '../../lib/api'
import { useCurrentServer } from '../../lib/currentServer'
import { GAME_LABEL, type Server, type ServerSettings } from '../../lib/types'
import { t, tn } from '../../i18n'

/**
 * Impostazioni di un server (solo admin). Nella Panoramica: nome, giocatori, motd e gioco/versione.
 * Nella pagina Impostazioni: porta, password e le altre chiavi di serverconfig.txt (base e avanzate).
 * Tutto vale dal prossimo avvio del server.
 */

function useSettingsOf(server: Server) {
  const settings = useServerSettings(server.id)
  const running = server.state !== 'stopped'
  const fallback = settings.isLoading ? (
    <div className="spinner" />
  ) : settings.error || !settings.data ? (
    <div className="alert alert-error">{errorMessage(settings.error)}</div>
  ) : null
  return { settings, running, fallback }
}

const restartNote = (running: boolean) => (running ? ` ${t('They apply from the next server restart.')}` : '')

// --- Panoramica ---------------------------------------------------------------------------------

export function OverviewSettings({ server }: { server: Server }) {
  const { settings, running, fallback } = useSettingsOf(server)
  if (fallback || !settings.data) return fallback
  return (
    <>
      <div className="card">
        <h2>{t('Server')}</h2>
        <GeneralForm key={settings.dataUpdatedAt} data={settings.data} running={running} />
      </div>
      <div className="card">
        <h2>{t('Game and version')}</h2>
        <VersionSwitch key={settings.data.id} data={settings.data} running={running} />
      </div>
    </>
  )
}

function GeneralForm({ data, running }: { data: ServerSettings; running: boolean }) {
  const { update } = useAdminServerActions()
  const [name, setName] = useState(data.name)
  const [maxPlayers, setMaxPlayers] = useState(data.maxPlayers)
  const [motd, setMotd] = useState(data.motd)
  const [saved, setSaved] = useState(false)
  const errors = fieldErrors(update.error)
  const dirty = name !== data.name || maxPlayers !== data.maxPlayers || motd !== data.motd

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setSaved(false)
    update.mutate({ id: data.id, name, maxPlayers, motd }, { onSuccess: () => setSaved(true) })
  }

  return (
    <form className="stack" onSubmit={submit}>
      <div className="form-inline">
        <label className="field">
          <span>{t('Name')}</span>
          <input required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
          {errors.name && <span className="error-text">{errors.name}</span>}
        </label>
        <label className="field field-narrow">
          <span>{t('Max players')}</span>
          <input type="number" required min={1} max={255} value={maxPlayers} onChange={(e) => setMaxPlayers(Number(e.target.value))} />
          {errors.maxPlayers && <span className="error-text">{errors.maxPlayers}</span>}
        </label>
      </div>
      <label className="field">
        <span>{t('Welcome message (motd)')}</span>
        <input maxLength={200} value={motd} onChange={(e) => setMotd(e.target.value)} placeholder={t('None')} />
        {errors.motd && <span className="error-text">{errors.motd}</span>}
      </label>
      {update.isError && !Object.keys(errors).length && <div className="alert alert-error">{errorMessage(update.error)}</div>}
      {saved && !dirty && <div className="alert alert-success">{t('Saved.')}{running && ` ${t('Players and motd apply from the next server restart.')}`}</div>}
      <div className="btn-row">
        <button type="submit" className="btn btn-primary btn-sm" disabled={!dirty || update.isPending}>
          {t('Save')}
        </button>
      </div>
    </form>
  )
}

/**
 * Cambio di gioco e versione del server (Terraria, TShock, tModLoader): il mondo resta lo stesso. Si può
 * scegliere anche una versione non ancora installata: il pannello la installa, spegne il server (salvando
 * il mondo), lo sposta e lo riaccende se era acceso. Se la versione scelta è più vecchia di quella che ha
 * salvato il mondo si avvisa (e si propone di ricrearlo), ma il cambio resta permesso.
 */
function VersionSwitch({ data, running }: { data: ServerSettings; running: boolean }) {
  const defaults = useServerDefaults(true)
  const { switchGame, recreateWorld } = useAdminServerActions()
  const [confirmRecreate, setConfirmRecreate] = useState(false)
  const [started, setStarted] = useState(false)
  const { fields, picked } = useInstallationPicker(defaults.data?.installations ?? [], { game: data.game, installDir: data.installDir })
  const changed = picked !== null && !('installDir' in picked.target && picked.target.installDir === data.installDir)
  const tooOld = changed && olderThanWorld(picked.worldRelease, data.worldRelease)
  // Mondo esistente e versione di destinazione ignota: si avvisa allo stesso modo, senza poter dire se è più vecchia
  const unknownWorld = changed && picked.toInstall && picked.worldRelease === null && data.worldRelease !== null
  const warn = tooOld || unknownWorld
  const target = picked ? `${GAME_LABEL[picked.game]} ${picked.release?.version ?? picked.choice?.version ?? ''}`.trim() : ''

  const apply = () => {
    if (!picked) return
    setStarted(false)
    switchGame.mutate({ id: data.id, ...picked.target }, { onSuccess: () => setStarted(true) })
  }

  return (
    <div className="stack">
      <div className="form-inline">
        {fields}
        <button
          type="button"
          className={warn ? 'btn btn-warning btn-sm' : 'btn btn-primary btn-sm'}
          disabled={!changed || switchGame.isPending || !defaults.data}
          onClick={apply}
        >
          {warn ? t('Switch anyway') : picked?.toInstall ? t('Install and switch') : t('Switch version')}
        </button>
      </div>
      <p className="muted small">
        <PickedHint picked={changed ? picked : null} />{' '}
        {t(
          'The world stays the same. With tModLoader the Mods, Workshop and Modpack sections appear; with TShock players join with regular Terraria. Mods, configuration and TShock plugins stay in the server folder even when switching to another game.',
        )}
        {changed && running && (
          <strong> {t('The server is running: it is stopped (saving the world) and started again with {target}.', { target })}</strong>
        )}
      </p>

      {warn && data.worldRelease !== null && (
        <div className="alert alert-warning">
          {tooOld ? (
            <p>
              {tn('The world {world} was saved with {saved}, newer than {target}. The server might fail to open it or crash.', {
                world: <strong>{data.worldName ?? ''}</strong>,
                saved: worldVersionLabel(data.worldRelease),
                target: picked?.worldRelease ? `${target} (${worldVersionLabel(picked.worldRelease)})` : target,
              })}
            </p>
          ) : (
            <p>
              {tn(
                'The world {world} was saved with {saved}. Until {target} is installed it is not known which world version it can open: if it is older, the server might fail to open it or crash.',
                { world: <strong>{data.worldName ?? ''}</strong>, saved: worldVersionLabel(data.worldRelease), target },
              )}
            </p>
          )}
          <p className="small">
            {t(
              'You can recreate the world from scratch (the current one goes to the server trash and stays recoverable) or try to open it with this version anyway.',
            )}
          </p>
          <div className="btn-row">
            {confirmRecreate ? (
              <>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={recreateWorld.isPending || running}
                  onClick={() => recreateWorld.mutate(data.id, { onSettled: () => setConfirmRecreate(false) })}
                >
                  {t('Confirm: recreate the world')}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmRecreate(false)}>
                  {t('Cancel')}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-danger-outline btn-sm"
                disabled={running}
                title={running ? t('Stop the server before recreating the world') : undefined}
                onClick={() => setConfirmRecreate(true)}
              >
                {t('Recreate the world from scratch')}
              </button>
            )}
          </div>
        </div>
      )}
      {recreateWorld.isSuccess && (
        <div className="alert alert-success">
          {t(
            'World moved to the trash ({files}). On the next start a new one will be generated with the name, size, difficulty and seed of the configuration.',
            { files: recreateWorld.data.trashed.join(', ') || t('no files') },
          )}
        </div>
      )}
      {recreateWorld.isError && <div className="alert alert-error">{errorMessage(recreateWorld.error)}</div>}
      {switchGame.isError && <div className="alert alert-error">{errorMessage(switchGame.error)}</div>}
      {started && (
        <div className="alert alert-info">
          {t('Switch started: the progress is at the top of the page.')}
        </div>
      )}
      {data.awaitingTshock && !changed && (
        <p className="small">
          {t(
            'This server was on TShock: when a TShock version for its Terraria version comes out, a button to move it back to TShock appears at the top of the page.',
          )}
        </p>
      )}
    </div>
  )
}

// --- Pagina Impostazioni ------------------------------------------------------------------------

type Option = [value: string, label: string]
type ConfigField = { key: string; label: string; hint?: string; options?: Option[]; placeholder?: string; pattern?: string; maxLength?: number }

const yesNo = (): Option[] => [
  ['1', t('Yes')],
  ['0', t('No')],
]

const basicFields = (): ConfigField[] => [
  {
    key: 'secure',
    label: t('Anti-cheat protection'),
    hint: t('Extra checks against modified clients (secure key).'),
    options: yesNo(),
  },
  {
    key: 'language',
    label: t('Server language'),
    hint: t('Language of the server messages, for example the chat ones (language key).'),
    options: [
      ['en-US', 'English'],
      ['it-IT', 'Italiano'],
      ['de-DE', 'Deutsch'],
      ['fr-FR', 'Français'],
      ['es-ES', 'Español'],
      ['pt-BR', 'Português (Brasil)'],
      ['pl-PL', 'Polski'],
      ['ru-RU', 'Русский'],
      ['zh-Hans', '简体中文'],
    ],
  },
]

const worldFields = (): ConfigField[] => [
  { key: 'worldname', label: t('World name'), pattern: "[A-Za-z0-9 _'\\-]{1,40}", maxLength: 40 },
  {
    key: 'autocreate',
    label: t('Size'),
    options: [
      ['1', t('Small')],
      ['2', t('Medium')],
      ['3', t('Large')],
    ],
  },
  {
    key: 'difficulty',
    label: t('Difficulty'),
    options: [
      ['0', t('Classic')],
      ['1', t('Expert')],
      ['2', t('Master')],
      ['3', t('Journey')],
    ],
  },
  { key: 'seed', label: 'Seed', placeholder: t('Random'), maxLength: 64 },
]

const networkFields = (): ConfigField[] => [
  {
    key: 'npcstream',
    label: 'NPC stream',
    hint: t('Lower values reduce enemy "skipping" but increase traffic; 0 turns it off. Default: 60.'),
    placeholder: '60',
    pattern: '\\d{1,4}',
    maxLength: 4,
  },
]

const journeyFields = (): ConfigField[] =>
  (
    [
      ['time_setfrozen', t('Freeze time')],
      ['time_setdawn', t('Set to dawn')],
      ['time_setnoon', t('Set to noon')],
      ['time_setdusk', t('Set to dusk')],
      ['time_setmidnight', t('Set to midnight')],
      ['time_setspeed', t('Time speed')],
      ['godmode', t('Godmode')],
      ['wind_setstrength', t('Wind strength')],
      ['wind_setfrozen', t('Freeze wind')],
      ['rain_setstrength', t('Rain strength')],
      ['rain_setfrozen', t('Freeze rain')],
      ['increaseplacementrange', t('Placement range')],
      ['setdifficulty', t('Enemy difficulty')],
      ['biomespread_setfrozen', t('Freeze biome spread')],
      ['setspawnrate', t('Enemy spawn rate')],
    ] as const
  ).map(([key, label]) => ({
    key: `journeypermission_${key}`,
    label,
    options: [
      ['2', t('Everyone')],
      ['1', t('Host only')],
      ['0', t('Nobody')],
    ],
  }))

const allFields = () => [...basicFields(), ...worldFields(), ...networkFields(), ...journeyFields()]

const ADVANCED_KEY = 'tmm:settings-advanced'
const readAdvanced = () => {
  try {
    return localStorage.getItem(ADVANCED_KEY) === '1'
  } catch {
    return false
  }
}

export function ServerSettingsTab() {
  const server = useCurrentServer()
  const { settings, running, fallback } = useSettingsOf(server)
  if (fallback || !settings.data) return fallback
  return <SettingsForm key={settings.dataUpdatedAt} data={settings.data} running={running} />
}

function SettingsForm({ data, running }: { data: ServerSettings; running: boolean }) {
  const { update } = useAdminServerActions()
  const [advanced, setAdvanced] = useState(readAdvanced)
  const [port, setPort] = useState(data.port)
  // La password attuale non viene mai mostrata: si sceglie se lasciarla, cambiarla o toglierla
  const [passwordMode, setPasswordMode] = useState<'keep' | 'set' | 'remove'>(data.hasPassword ? 'keep' : 'remove')
  const [password, setPassword] = useState('')
  // '' = chiave assente, cioè il default di Terraria
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(allFields().map((f) => [f.key, data.config[f.key] ?? ''])))
  const [launchArgs, setLaunchArgs] = useState(data.launchArgs.join(' '))
  const [saved, setSaved] = useState(false)
  const errors = fieldErrors(update.error)

  const toggleAdvanced = () => {
    setAdvanced((v) => {
      try {
        localStorage.setItem(ADVANCED_KEY, v ? '0' : '1')
      } catch {
        // solo una comodità
      }
      return !v
    })
  }

  const configChanges = Object.fromEntries(
    allFields().filter((f) => values[f.key].trim() !== (data.config[f.key] ?? '')).map((f) => [f.key, values[f.key].trim() || null]),
  )
  const args = launchArgs.split(/\s+/).filter(Boolean)
  const argsChanged = args.join(' ') !== data.launchArgs.join(' ')
  const passwordChange = passwordMode === 'set' ? { password } : passwordMode === 'remove' && data.hasPassword ? { password: '' } : {}
  const dirty = port !== data.port || Object.keys(configChanges).length > 0 || argsChanged || 'password' in passwordChange

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setSaved(false)
    update.mutate(
      {
        id: data.id,
        ...(port !== data.port && { port }),
        ...passwordChange,
        ...(Object.keys(configChanges).length && { config: configChanges }),
        ...(argsChanged && { launchArgs: args }),
      },
      { onSuccess: () => setSaved(true) },
    )
  }

  const field = (f: ConfigField) => (
    <ConfigInput key={f.key} field={f} value={values[f.key]} error={errors[`config.${f.key}`]} onChange={(v) => setValues((old) => ({ ...old, [f.key]: v }))} />
  )

  return (
    <form className="stack" onSubmit={submit}>
      <div className="card">
        <h2>{t('Connection')}</h2>
        <div className="form-inline">
          <label className="field field-narrow">
            <span>{t('Port')}</span>
            <input type="number" required min={1024} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} />
          </label>
          <label className="field">
            <span>Password</span>
            <select value={passwordMode} onChange={(e) => setPasswordMode(e.target.value as typeof passwordMode)}>
              {data.hasPassword && <option value="keep">{t('Keep the current one')}</option>}
              <option value="set">{data.hasPassword ? t('Change password') : t('Set a password')}</option>
              <option value="remove">{data.hasPassword ? t('Remove the password') : t('No password')}</option>
            </select>
          </label>
          {passwordMode === 'set' && (
            <label className="field">
              <span>{t('New password')}</span>
              <input required maxLength={64} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </label>
          )}
        </div>
        {errors.port && <span className="error-text">{errors.port}</span>}
        {errors.password && <span className="error-text">{errors.password}</span>}
        {!data.hasPassword && passwordMode !== 'set' && <p className="muted small">{t('Without a password anyone who knows the address and port can join.')}</p>}
      </div>

      <div className="card">
        <h2>{t('General')}</h2>
        <div className="stack">{basicFields().map(field)}</div>
      </div>

      <div className="btn-row">
        <button type="button" className="btn btn-sm" aria-expanded={advanced} onClick={toggleAdvanced}>
          {advanced ? t('Hide advanced') : t('Advanced')}
        </button>
      </div>

      {advanced && (
        <>
          <Section
            title={t('World generation')}
            hint={t('Used only when the world is created: on the first start or after recreating it from scratch. They do not change the current world.')}
          >
            <div className="form-inline">{worldFields().map(field)}</div>
          </Section>
          <Section title={t('Network')}>{networkFields().map(field)}</Section>
          <Section
            title={t('Journey mode permissions')}
            hint={t('Who can use the Journey mode powers (only in worlds created in Journey). The host is the first player who joined.')}
          >
            <div className="settings-grid">{journeyFields().map(field)}</div>
          </Section>
          <Section title={t('Startup')} hint={t('Arguments passed to the server executable, separated by spaces.')}>
            <label className="field">
              <span>{t('Launch arguments')}</span>
              <input className="mono" value={launchArgs} onChange={(e) => setLaunchArgs(e.target.value)} placeholder="-nosteam" />
              {errors.launchArgs && <span className="error-text">{errors.launchArgs}</span>}
            </label>
            <p className="muted small">
              {t('Configuration:')} <span className="mono">{data.configPath}</span>
              <br />
              {t('World:')} <span className="mono">{data.world ?? '—'}</span>
            </p>
          </Section>
        </>
      )}

      {update.isError && !Object.keys(errors).length && <div className="alert alert-error">{errorMessage(update.error)}</div>}
      {saved && !dirty && <div className="alert alert-success">{t('Settings saved.')}{restartNote(running)}</div>}
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={!dirty || update.isPending}>
          {t('Save')}
        </button>
        {dirty && <span className="muted small">{t('Unsaved changes')}</span>}
      </div>
    </form>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      <div className="stack">
        {hint && <p className="muted small">{hint}</p>}
        {children}
      </div>
    </div>
  )
}

function ConfigInput({ field, value, error, onChange }: { field: ConfigField; value: string; error?: string; onChange: (value: string) => void }) {
  return (
    <label className="field">
      <span>{field.label}</span>
      {field.options ? (
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t('Default')}</option>
          {/* Un valore nel file che il pannello non conosce resta selezionabile */}
          {value && !field.options.some(([v]) => v === value) && <option value={value}>{value}</option>}
          {field.options.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder ?? t('Default')} pattern={field.pattern} maxLength={field.maxLength} />
      )}
      {field.hint && <span className="small">{field.hint}</span>}
      {error && <span className="error-text">{error}</span>}
    </label>
  )
}

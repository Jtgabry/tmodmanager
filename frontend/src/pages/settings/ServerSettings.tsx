import { type FormEvent, type ReactNode, useState } from 'react'
import { type AutoInstall, choiceLabel, olderThanWorld, useAdminServerActions, useReleases, useServerDefaults, useServerSettings, worldVersionLabel } from '../../lib/admin'
import { errorMessage, fieldErrors } from '../../lib/api'
import { useCurrentServer } from '../../lib/currentServer'
import { GAME_LABEL, type InstallationChoice, type Server, type ServerSettings } from '../../lib/types'

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

const restartNote = (running: boolean) => (running ? ' Valgono dal prossimo riavvio del server.' : '')

// --- Panoramica ---------------------------------------------------------------------------------

export function OverviewSettings({ server }: { server: Server }) {
  const { settings, running, fallback } = useSettingsOf(server)
  if (fallback || !settings.data) return fallback
  return (
    <>
      <div className="card">
        <h2>Server</h2>
        <GeneralForm key={settings.dataUpdatedAt} data={settings.data} running={running} />
      </div>
      <div className="card">
        <h2>Gioco e versione</h2>
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
          <span>Nome</span>
          <input required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
          {errors.name && <span className="error-text">{errors.name}</span>}
        </label>
        <label className="field field-narrow">
          <span>Giocatori max</span>
          <input type="number" required min={1} max={255} value={maxPlayers} onChange={(e) => setMaxPlayers(Number(e.target.value))} />
          {errors.maxPlayers && <span className="error-text">{errors.maxPlayers}</span>}
        </label>
      </div>
      <label className="field">
        <span>Messaggio di benvenuto (motd)</span>
        <input maxLength={200} value={motd} onChange={(e) => setMotd(e.target.value)} placeholder="Nessuno" />
        {errors.motd && <span className="error-text">{errors.motd}</span>}
      </label>
      {update.isError && !Object.keys(errors).length && <div className="alert alert-error">{errorMessage(update.error)}</div>}
      {saved && !dirty && <div className="alert alert-success">Salvato.{running && ' Giocatori e motd valgono dal prossimo riavvio del server.'}</div>}
      <div className="btn-row">
        <button type="submit" className="btn btn-primary btn-sm" disabled={!dirty || update.isPending}>
          Salva
        </button>
      </div>
    </form>
  )
}

/**
 * Cambio di versione del server, anche tra Terraria vanilla e tModLoader: il mondo resta lo stesso.
 * Se la versione scelta è più vecchia di quella che ha salvato il mondo si avvisa (e si propone di
 * ricrearlo), ma il cambio resta permesso.
 */
function VersionSwitch({ data, running }: { data: ServerSettings; running: boolean }) {
  const defaults = useServerDefaults(true)
  const { update, recreateWorld } = useAdminServerActions()
  const [target, setTarget] = useState(data.installDir)
  const [confirmRecreate, setConfirmRecreate] = useState(false)
  const [switched, setSwitched] = useState<{ choice: InstallationChoice | null; install: AutoInstall | null } | null>(null)
  // Anche i giochi non ancora installati: scegliendoli si installa l'ultima versione
  const choices = defaults.data?.installations ?? []
  const chosen = choices.find((c) => c.path === target)
  const changed = target !== data.installDir
  const toInstall = changed && chosen !== undefined && !chosen.installed
  // Versione dei mondi di un gioco da installare: quella dell'ultima release, se nota (Terraria sì, tModLoader no)
  const releases = useReleases(chosen?.kind ?? 'terraria', toInstall && !chosen?.installing)
  const targetWorld = !toInstall ? chosen?.worldRelease : (releases.data?.find((r) => !r.prerelease)?.worldRelease ?? null)
  const tooOld = changed && olderThanWorld(targetWorld, data.worldRelease)
  // Mondo esistente e versione di destinazione ignota: si avvisa allo stesso modo, senza poter dire se è più vecchia
  const unknownWorld = toInstall && targetWorld === null && data.worldRelease !== null
  const warn = tooOld || unknownWorld

  const apply = () => {
    setSwitched(null)
    update.mutate({ id: data.id, installDir: target }, { onSuccess: (r) => setSwitched({ choice: chosen ?? null, install: r.install ?? null }) })
  }

  return (
    <div className="stack">
      <div className="form-inline">
        <label className="field">
          <span>Installazione</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={!defaults.data}>
            {!choices.some((c) => c.path === data.installDir) && (
              <option value={data.installDir}>
                {GAME_LABEL[data.game]} — {data.installDir}
              </option>
            )}
            {choices.map((c) => (
              <option key={c.path} value={c.path}>
                {choiceLabel(c)}
                {c.path === data.installDir ? ' — attuale' : ''}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={warn ? 'btn btn-warning btn-sm' : 'btn btn-primary btn-sm'}
          disabled={!changed || running || update.isPending}
          title={running ? 'Spegni il server per cambiare versione' : undefined}
          onClick={apply}
        >
          {warn ? 'Cambia comunque' : toInstall ? 'Installa e cambia' : 'Cambia versione'}
        </button>
      </div>
      <p className="muted small">
        Il mondo resta lo stesso. Con tModLoader compaiono le sezioni Mod, Workshop e Modpack; tornando a Terraria
        vanilla le mod restano sul disco. Con TShock i giocatori entrano con Terraria normale; configurazione, account e
        plugin di TShock restano nella cartella del server anche passando a un altro gioco. I giocatori devono usare la
        stessa versione di Terraria del server (o tModLoader, per un server tModLoader).
        {toInstall && ` ${GAME_LABEL[chosen.kind]} non è ancora installato: ${chosen.installing ? 'si sta già installando' : "viene installata l'ultima versione"}, e il server si potrà accendere quando è finito.`}
        {running && <strong> Spegni il server per cambiare versione.</strong>}
      </p>

      {warn && data.worldRelease !== null && (
        <div className="alert alert-warning">
          {tooOld ? (
            <p>
              Il mondo <strong>{data.worldName ?? ''}</strong> è stato salvato con {worldVersionLabel(data.worldRelease)}, più
              recente di quella usata da {chosen ? choiceLabel(chosen) : 'questa versione'}
              {targetWorld ? ` (${worldVersionLabel(targetWorld)})` : ''}. Il server potrebbe non riuscire ad aprirlo o
              andare in crash.
            </p>
          ) : (
            <p>
              Il mondo <strong>{data.worldName ?? ''}</strong> è stato salvato con {worldVersionLabel(data.worldRelease)}.
              Finché {chosen ? GAME_LABEL[chosen.kind] : 'il gioco'} non è installato non si sa quale versione dei mondi sappia
              aprire: se è più vecchia, il server potrebbe non riuscire ad aprirlo o andare in crash.
            </p>
          )}
          <p className="small">
            Puoi ricreare il mondo da capo (quello attuale va nel cestino del server e resta recuperabile) oppure provare
            comunque ad aprirlo con questa versione.
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
                  Conferma: ricrea il mondo
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmRecreate(false)}>
                  Annulla
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-danger-outline btn-sm"
                disabled={running}
                title={running ? 'Spegni il server prima di ricreare il mondo' : undefined}
                onClick={() => setConfirmRecreate(true)}
              >
                Ricrea il mondo da capo
              </button>
            )}
          </div>
        </div>
      )}
      {recreateWorld.isSuccess && (
        <div className="alert alert-success">
          Mondo spostato nel cestino ({recreateWorld.data.trashed.join(', ') || 'nessun file'}). Al prossimo avvio ne
          verrà generato uno nuovo con nome, dimensione, difficoltà e seed della configurazione.
        </div>
      )}
      {recreateWorld.isError && <div className="alert alert-error">{errorMessage(recreateWorld.error)}</div>}
      {update.isError && <div className="alert alert-error">{errorMessage(update.error)}</div>}
      {data.awaitingTshock && !changed && (
        <p className="small">
          Questo server era su TShock: quando esce una versione di TShock per la sua versione di Terraria, in cima alla
          pagina compare il pulsante per riportarlo su TShock.
        </p>
      )}
      {switched?.choice && (
        <div className="alert alert-success">
          Ora il server usa {switched.install ? GAME_LABEL[switched.choice.kind] : choiceLabel(switched.choice)}: vale dal prossimo avvio.
          {switched.choice.kind === 'tmodloader' && ' Nella barra laterale del server ci sono le sezioni Mod, Workshop e Modpack.'}
        </div>
      )}
      {switched?.install && !switched.install.error && (
        <div className="alert alert-info">
          Installazione di {GAME_LABEL[switched.install.game]} {switched.install.version ?? ''} in corso: il server si può
          accendere quando è finita (l'avanzamento è in Gestione server → Installazioni).
        </div>
      )}
      {switched?.install?.error && (
        <div className="alert alert-warning">
          {GAME_LABEL[switched.install.game]} non è stato installato: {switched.install.error}. Installalo da Gestione server →
          Installazioni prima di accendere il server.
        </div>
      )}
    </div>
  )
}

// --- Pagina Impostazioni ------------------------------------------------------------------------

type Option = [value: string, label: string]
type ConfigField = { key: string; label: string; hint?: string; options?: Option[]; placeholder?: string; pattern?: string; maxLength?: number }

const YES_NO: Option[] = [
  ['1', 'Sì'],
  ['0', 'No'],
]

const BASIC_FIELDS: ConfigField[] = [
  {
    key: 'secure',
    label: 'Protezione anti-cheat',
    hint: 'Controlli aggiuntivi contro i client modificati (chiave secure).',
    options: YES_NO,
  },
  {
    key: 'language',
    label: 'Lingua del server',
    hint: 'Lingua dei messaggi del server, ad esempio quelli in chat (chiave language).',
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

const WORLD_FIELDS: ConfigField[] = [
  { key: 'worldname', label: 'Nome del mondo', pattern: "[A-Za-z0-9 _'\\-]{1,40}", maxLength: 40 },
  {
    key: 'autocreate',
    label: 'Dimensione',
    options: [
      ['1', 'Piccolo'],
      ['2', 'Medio'],
      ['3', 'Grande'],
    ],
  },
  {
    key: 'difficulty',
    label: 'Difficoltà',
    options: [
      ['0', 'Classica'],
      ['1', 'Esperto'],
      ['2', 'Maestro'],
      ['3', 'Viaggio'],
    ],
  },
  { key: 'seed', label: 'Seed', placeholder: 'Casuale', maxLength: 64 },
]

const NETWORK_FIELDS: ConfigField[] = [
  {
    key: 'npcstream',
    label: 'NPC stream',
    hint: 'Valori più bassi riducono i "salti" dei nemici ma aumentano il traffico; 0 lo disattiva. Predefinito: 60.',
    placeholder: '60',
    pattern: '\\d{1,4}',
    maxLength: 4,
  },
]

const JOURNEY_FIELDS: ConfigField[] = (
  [
    ['time_setfrozen', 'Fermare il tempo'],
    ['time_setdawn', "Portare all'alba"],
    ['time_setnoon', 'Portare a mezzogiorno'],
    ['time_setdusk', 'Portare al tramonto'],
    ['time_setmidnight', 'Portare a mezzanotte'],
    ['time_setspeed', 'Velocità del tempo'],
    ['godmode', 'Modalità divina'],
    ['wind_setstrength', 'Forza del vento'],
    ['wind_setfrozen', 'Fermare il vento'],
    ['rain_setstrength', 'Intensità della pioggia'],
    ['rain_setfrozen', 'Fermare la pioggia'],
    ['increaseplacementrange', 'Raggio di piazzamento'],
    ['setdifficulty', 'Difficoltà dei nemici'],
    ['biomespread_setfrozen', 'Fermare la diffusione dei biomi'],
    ['setspawnrate', 'Frequenza di comparsa dei nemici'],
  ] as const
).map(([key, label]) => ({
  key: `journeypermission_${key}`,
  label,
  options: [
    ['2', 'Tutti'],
    ['1', "Solo l'host"],
    ['0', 'Nessuno'],
  ],
}))

const ALL_FIELDS = [...BASIC_FIELDS, ...WORLD_FIELDS, ...NETWORK_FIELDS, ...JOURNEY_FIELDS]

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
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(ALL_FIELDS.map((f) => [f.key, data.config[f.key] ?? ''])))
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
    ALL_FIELDS.filter((f) => values[f.key].trim() !== (data.config[f.key] ?? '')).map((f) => [f.key, values[f.key].trim() || null]),
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
        <h2>Connessione</h2>
        <div className="form-inline">
          <label className="field field-narrow">
            <span>Porta</span>
            <input type="number" required min={1024} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} />
          </label>
          <label className="field">
            <span>Password</span>
            <select value={passwordMode} onChange={(e) => setPasswordMode(e.target.value as typeof passwordMode)}>
              {data.hasPassword && <option value="keep">Lascia quella attuale</option>}
              <option value="set">{data.hasPassword ? 'Cambia password' : 'Imposta una password'}</option>
              <option value="remove">{data.hasPassword ? 'Togli la password' : 'Nessuna password'}</option>
            </select>
          </label>
          {passwordMode === 'set' && (
            <label className="field">
              <span>Nuova password</span>
              <input required maxLength={64} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </label>
          )}
        </div>
        {errors.port && <span className="error-text">{errors.port}</span>}
        {errors.password && <span className="error-text">{errors.password}</span>}
        {!data.hasPassword && passwordMode !== 'set' && <p className="muted small">Senza password chiunque conosca indirizzo e porta può entrare.</p>}
      </div>

      <div className="card">
        <h2>Generale</h2>
        <div className="stack">{BASIC_FIELDS.map(field)}</div>
      </div>

      <div className="btn-row">
        <button type="button" className="btn btn-sm" aria-expanded={advanced} onClick={toggleAdvanced}>
          {advanced ? 'Nascondi avanzate' : 'Avanzate'}
        </button>
      </div>

      {advanced && (
        <>
          <Section title="Generazione del mondo" hint="Si usano solo quando il mondo viene creato: al primo avvio o dopo averlo ricreato da capo. Non cambiano il mondo attuale.">
            <div className="form-inline">{WORLD_FIELDS.map(field)}</div>
          </Section>
          <Section title="Rete">{NETWORK_FIELDS.map(field)}</Section>
          <Section
            title="Permessi della modalità Viaggio"
            hint="Chi può usare i poteri della modalità Viaggio (solo nei mondi creati in Viaggio). L'host è il primo giocatore entrato."
          >
            <div className="settings-grid">{JOURNEY_FIELDS.map(field)}</div>
          </Section>
          <Section title="Avvio" hint="Argomenti passati all'eseguibile del server, separati da spazi.">
            <label className="field">
              <span>Argomenti di avvio</span>
              <input className="mono" value={launchArgs} onChange={(e) => setLaunchArgs(e.target.value)} placeholder="-nosteam" />
              {errors.launchArgs && <span className="error-text">{errors.launchArgs}</span>}
            </label>
            <p className="muted small">
              Configurazione: <span className="mono">{data.configPath}</span>
              <br />
              Mondo: <span className="mono">{data.world ?? '—'}</span>
            </p>
          </Section>
        </>
      )}

      {update.isError && !Object.keys(errors).length && <div className="alert alert-error">{errorMessage(update.error)}</div>}
      {saved && !dirty && <div className="alert alert-success">Impostazioni salvate.{restartNote(running)}</div>}
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={!dirty || update.isPending}>
          Salva
        </button>
        {dirty && <span className="muted small">Modifiche non salvate</span>}
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
          <option value="">Predefinito</option>
          {/* Un valore nel file che il pannello non conosce resta selezionabile */}
          {value && !field.options.some(([v]) => v === value) && <option value={value}>{value}</option>}
          {field.options.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder ?? 'Predefinito'} pattern={field.pattern} maxLength={field.maxLength} />
      )}
      {field.hint && <span className="small">{field.hint}</span>}
      {error && <span className="error-text">{error}</span>}
    </label>
  )
}

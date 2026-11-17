import { type FormEvent, useState } from 'react'
import { Link } from 'react-router-dom'
import StateBadge from '../../components/StateBadge'
import {
  compareVersions,
  type NewServer,
  olderThanWorld,
  useAdminServerActions,
  useInstallations,
  useReleases,
  useServerDefaults,
  useServerSettings,
  worldVersionLabel,
} from '../../lib/admin'
import { errorMessage, fieldErrors } from '../../lib/api'
import { formatBytes, formatDate } from '../../lib/format'
import { useServers } from '../../lib/servers'
import { GAME_LABEL, type Installation, type InstallationChoice, type Server, type ServerSettings } from '../../lib/types'

export default function ServersAdminPage() {
  const [creating, setCreating] = useState(false)
  const servers = useServers()

  return (
    <section>
      <div className="page-header">
        <h1>Gestione server</h1>
        {!creating && (
          <div className="btn-row">
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              + Nuovo server
            </button>
          </div>
        )}
      </div>

      {creating && <NewServerForm servers={servers.data ?? []} onDone={() => setCreating(false)} />}

      <div className="card">
        <h2>Server</h2>
        {servers.isLoading && <div className="spinner" />}
        {servers.error && <div className="alert alert-error">{errorMessage(servers.error)}</div>}
        <div className="stack">
          {servers.data?.map((s) => <ServerRow key={s.id} server={s} />)}
        </div>
      </div>

      <InstallationsSection servers={servers.data ?? []} />
    </section>
  )
}

// --- Server esistenti ----------------------------------------------------------------------------

function ServerRow({ server }: { server: Server }) {
  const [editing, setEditing] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removedDir, setRemovedDir] = useState<string | null>(null)
  const { remove } = useAdminServerActions()

  if (removedDir) {
    return (
      <div className="alert alert-success">
        {server.name} è stato tolto dal pannello. I suoi file sono ancora in <span className="mono">{removedDir}</span>.
      </div>
    )
  }

  return (
    <article className="pack">
      <header>
        <div>
          <Link to={`/servers/${server.id}`}>
            <strong>{server.name}</strong>
          </Link>{' '}
          <StateBadge state={server.state} />
          <div className="muted small">
            id <span className="mono">{server.id}</span> · porta {server.port} · max {server.players.max} giocatori ·{' '}
            {server.hasPassword ? 'con password' : <span className="error-text">senza password</span>}
            {` · ${GAME_LABEL[server.game]} ${server.version ?? ''}`}
          </div>
        </div>
        <div className="btn-row">
          <button type="button" className="btn btn-sm" onClick={() => setEditing((v) => !v)}>
            {editing ? 'Chiudi' : 'Impostazioni'}
          </button>
          {confirmRemove ? (
            <>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={remove.isPending}
                onClick={() => remove.mutate(server.id, { onSuccess: (r) => setRemovedDir(r.saveDir), onSettled: () => setConfirmRemove(false) })}
              >
                Conferma rimozione
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmRemove(false)}>
                Annulla
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-danger-outline btn-sm"
              disabled={server.state !== 'stopped'}
              title={server.state !== 'stopped' ? 'Spegni il server prima di rimuoverlo' : 'Toglie il server dal pannello; i file restano su disco'}
              onClick={() => setConfirmRemove(true)}
            >
              Rimuovi
            </button>
          )}
        </div>
      </header>
      {confirmRemove && (
        <p className="hint">
          Il server viene tolto dal pannello (insieme ai suoi modpack e ai permessi degli utenti). Mondo, mod e
          configurazione restano su disco.
        </p>
      )}
      {remove.isError && <div className="alert alert-error">{errorMessage(remove.error)}</div>}
      {editing && <SettingsForm serverId={server.id} running={server.state !== 'stopped'} onDone={() => setEditing(false)} />}
    </article>
  )
}

function SettingsForm({ serverId, running, onDone }: { serverId: string; running: boolean; onDone: () => void }) {
  const settings = useServerSettings(serverId)
  if (settings.isLoading) return <div className="spinner" />
  if (settings.error || !settings.data) return <div className="alert alert-error">{errorMessage(settings.error)}</div>
  return (
    <>
      <SettingsFields key={settings.dataUpdatedAt} data={settings.data} running={running} onDone={onDone} />
      <VersionSwitch key={settings.data.id} data={settings.data} running={running} />
    </>
  )
}

const choiceLabel = (c: InstallationChoice) =>
  `${GAME_LABEL[c.kind]} ${c.version ?? '?'}${c.kind === 'tmodloader' && c.gameVersion ? ` (Terraria ${c.gameVersion})` : ''}${c.managed ? '' : ` — ${c.path}`}`

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
  const [switched, setSwitched] = useState<InstallationChoice | null>(null)
  const choices = defaults.data?.installations ?? []
  const chosen = choices.find((c) => c.path === target)
  const changed = target !== data.installDir
  const tooOld = changed && olderThanWorld(chosen?.worldRelease, data.worldRelease)

  const apply = () =>
    update.mutate({ id: data.id, installDir: target }, { onSuccess: () => setSwitched(chosen ?? null) })

  return (
    <div className="pack-form">
      <h4>Versione</h4>
      <div className="form-inline">
        <label className="field">
          <span>Gioco e versione</span>
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
          className={tooOld ? 'btn btn-warning btn-sm' : 'btn btn-primary btn-sm'}
          disabled={!changed || running || update.isPending}
          title={running ? 'Spegni il server per cambiare versione' : undefined}
          onClick={apply}
        >
          {tooOld ? 'Cambia comunque' : 'Cambia versione'}
        </button>
      </div>
      <p className="muted small">
        Il mondo resta lo stesso. Con tModLoader compaiono le sezioni Mod, Workshop e Modpack; tornando a Terraria
        vanilla le mod restano sul disco. I giocatori devono usare lo stesso gioco e la stessa versione del server.
        {running && <strong> Spegni il server per cambiare versione.</strong>}
      </p>

      {tooOld && data.worldRelease !== null && (
        <div className="alert alert-warning">
          <p>
            Il mondo <strong>{data.worldName ?? ''}</strong> è stato salvato con {worldVersionLabel(data.worldRelease)}, più
            recente di quella usata da {chosen ? choiceLabel(chosen) : 'questa versione'}
            {chosen?.worldRelease ? ` (${worldVersionLabel(chosen.worldRelease)})` : ''}. Il server potrebbe non riuscire ad
            aprirlo o andare in crash.
          </p>
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
      {switched && (
        <div className="alert alert-success">
          Ora il server usa {choiceLabel(switched)}: vale dal prossimo avvio.
          {switched.kind === 'tmodloader' && ' Nella barra laterale del server ci sono le sezioni Mod, Workshop e Modpack.'}
        </div>
      )}
    </div>
  )
}

function SettingsFields({
  data,
  running,
  onDone,
}: {
  data: NonNullable<ReturnType<typeof useServerSettings>['data']>
  running: boolean
  onDone: () => void
}) {
  const { update } = useAdminServerActions()
  const [name, setName] = useState(data.name)
  const [port, setPort] = useState(data.port)
  const [maxPlayers, setMaxPlayers] = useState(data.maxPlayers)
  const [motd, setMotd] = useState(data.motd)
  // La password attuale non viene mai mostrata: si sceglie se lasciarla, cambiarla o toglierla
  const [passwordMode, setPasswordMode] = useState<'keep' | 'set' | 'remove'>(data.hasPassword ? 'keep' : 'remove')
  const [password, setPassword] = useState('')
  const [saved, setSaved] = useState(false)
  const errors = fieldErrors(update.error)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setSaved(false)
    update.mutate(
      {
        id: data.id,
        name,
        port,
        maxPlayers,
        motd,
        ...(passwordMode === 'set' ? { password } : passwordMode === 'remove' && data.hasPassword ? { password: '' } : {}),
      },
      { onSuccess: () => setSaved(true) },
    )
  }

  return (
    <form className="pack-form" onSubmit={submit}>
      <div className="form-inline">
        <label className="field">
          <span>Nome</span>
          <input required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
          {errors.name && <span className="error-text">{errors.name}</span>}
        </label>
        <label className="field">
          <span>Porta</span>
          <input type="number" required min={1024} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} />
          {errors.port && <span className="error-text">{errors.port}</span>}
        </label>
        <label className="field">
          <span>Giocatori max</span>
          <input type="number" required min={1} max={255} value={maxPlayers} onChange={(e) => setMaxPlayers(Number(e.target.value))} />
        </label>
      </div>
      <div className="form-inline">
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
            {errors.password && <span className="error-text">{errors.password}</span>}
          </label>
        )}
        <label className="field">
          <span>Messaggio di benvenuto (motd)</span>
          <input maxLength={200} value={motd} onChange={(e) => setMotd(e.target.value)} />
        </label>
      </div>
      <p className="muted small">
        Mondo: <span className="mono">{data.world ?? '—'}</span>
        <br />
        Configurazione: <span className="mono">{data.configPath}</span> · Dati: <span className="mono">{data.saveDir}</span>
      </p>
      {update.isError && !Object.keys(errors).length && <div className="alert alert-error">{errorMessage(update.error)}</div>}
      {saved && (
        <div className="alert alert-success">
          Impostazioni salvate.{running && ' Porta, giocatori, password e motd valgono dal prossimo riavvio del server.'}
        </div>
      )}
      <div className="btn-row">
        <button type="submit" className="btn btn-primary btn-sm" disabled={update.isPending}>
          Salva
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
          Chiudi
        </button>
      </div>
    </form>
  )
}

// --- Nuovo server --------------------------------------------------------------------------------

const slug = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)

function NewServerForm({ servers, onDone }: { servers: Server[]; onDone: () => void }) {
  const defaults = useServerDefaults(true)
  const { create } = useAdminServerActions()
  const [name, setName] = useState('')
  const [id, setId] = useState('')
  const [idTouched, setIdTouched] = useState(false)
  const [port, setPort] = useState<number | ''>('')
  const [maxPlayers, setMaxPlayers] = useState(8)
  const [password, setPassword] = useState('')
  const [motd, setMotd] = useState('')
  const [installDir, setInstallDir] = useState('')
  const [world, setWorld] = useState<NewServer['world']>({ name: '', size: 2, difficulty: 1, seed: '' })
  const [copyModsFrom, setCopyModsFrom] = useState('')
  const [created, setCreated] = useState<{ id: string; saveDir: string } | null>(null)
  const errors = fieldErrors(create.error)
  const conflictField = (create.error as { response?: { data?: { details?: { field?: string } } } } | null)?.response?.data?.details?.field

  const effectivePort = port === '' ? (defaults.data?.port ?? 7777) : port
  const choices = defaults.data?.installations ?? []
  // Di default i server nascono vanilla (Terraria); tModLoader si sceglie qui o dopo, dalle impostazioni
  const effectiveInstall = installDir || choices.find((c) => c.kind === 'terraria')?.path || choices[0]?.path || ''
  const chosen = choices.find((c) => c.path === effectiveInstall)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate(
      {
        id,
        name,
        installDir: effectiveInstall,
        port: effectivePort,
        maxPlayers,
        password,
        motd,
        world: { ...world, name: world.name || name },
        copyModsFrom: chosen?.kind === 'tmodloader' ? copyModsFrom || null : null,
      },
      { onSuccess: setCreated },
    )
  }

  if (created) {
    return (
      <div className="card">
        <div className="alert alert-success">
          Server creato in <span className="mono">{created.saveDir}</span>. Al primo avvio il mondo viene generato: può
          richiedere qualche minuto. Ricordati di dare i permessi agli utenti dalla pagina Utenti.
        </div>
        <div className="btn-row">
          <Link className="btn btn-primary btn-sm" to={`/servers/${created.id}`}>
            Apri il server
          </Link>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
            Chiudi
          </button>
        </div>
      </div>
    )
  }

  const fieldError = (key: string) => errors[key] ?? (conflictField === key ? errorMessage(create.error) : undefined)

  return (
    <form className="card pack-form" onSubmit={submit}>
      <h2>Nuovo server</h2>
      <div className="form-inline">
        <label className="field">
          <span>Nome</span>
          <input
            required
            autoFocus
            maxLength={64}
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              if (!idTouched) setId(slug(e.target.value))
            }}
          />
          {fieldError('name') && <span className="error-text">{fieldError('name')}</span>}
        </label>
        <label className="field">
          <span>Id (negli URL e nel nome della cartella)</span>
          <input
            required
            pattern="[a-z0-9][a-z0-9\-]{0,31}"
            maxLength={32}
            value={id}
            onChange={(e) => {
              setIdTouched(true)
              setId(e.target.value)
            }}
          />
          {fieldError('id') && <span className="error-text">{fieldError('id')}</span>}
        </label>
      </div>

      <div className="form-inline">
        <label className="field">
          <span>Porta</span>
          <input
            type="number"
            min={defaults.data?.ports?.min ?? 1024}
            max={defaults.data?.ports?.max ?? 65535}
            placeholder={String(defaults.data?.port ?? 7777)}
            value={port}
            onChange={(e) => setPort(e.target.value === '' ? '' : Number(e.target.value))}
          />
          {fieldError('port') ? (
            <span className="error-text">{fieldError('port')}</span>
          ) : (
            defaults.data?.ports && (
              <span className="muted small">
                Porte disponibili: {defaults.data.ports.min}–{defaults.data.ports.max}
              </span>
            )
          )}
        </label>
        <label className="field">
          <span>Giocatori max</span>
          <input type="number" required min={1} max={255} value={maxPlayers} onChange={(e) => setMaxPlayers(Number(e.target.value))} />
        </label>
        <label className="field">
          <span>Password (consigliata)</span>
          <input maxLength={64} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          {fieldError('password') && <span className="error-text">{fieldError('password')}</span>}
        </label>
        <label className="field">
          <span>Messaggio di benvenuto</span>
          <input maxLength={200} value={motd} onChange={(e) => setMotd(e.target.value)} />
        </label>
      </div>

      <h3>Mondo</h3>
      <div className="form-inline">
        <label className="field">
          <span>Nome del mondo</span>
          <input
            maxLength={40}
            pattern="[A-Za-z0-9 _'\-]{1,40}"
            placeholder={name || 'Come il server'}
            value={world.name}
            onChange={(e) => setWorld({ ...world, name: e.target.value })}
          />
          {fieldError('world.name') && <span className="error-text">{fieldError('world.name')}</span>}
        </label>
        <label className="field">
          <span>Dimensione</span>
          <select value={world.size} onChange={(e) => setWorld({ ...world, size: Number(e.target.value) as 1 | 2 | 3 })}>
            <option value={1}>Piccolo</option>
            <option value={2}>Medio</option>
            <option value={3}>Grande</option>
          </select>
        </label>
        <label className="field">
          <span>Difficoltà</span>
          <select value={world.difficulty} onChange={(e) => setWorld({ ...world, difficulty: Number(e.target.value) as 0 | 1 | 2 | 3 })}>
            <option value={0}>Classica</option>
            <option value={1}>Esperto</option>
            <option value={2}>Maestro</option>
            <option value={3}>Viaggio</option>
          </select>
        </label>
        <label className="field">
          <span>Seed (facoltativo)</span>
          <input maxLength={64} value={world.seed} onChange={(e) => setWorld({ ...world, seed: e.target.value })} />
        </label>
      </div>

      <h3>Versione</h3>
      <div className="form-inline">
        <label className="field">
          <span>Gioco e versione</span>
          <select value={effectiveInstall} onChange={(e) => setInstallDir(e.target.value)} disabled={!choices.length}>
            {choices.map((c) => (
              <option key={c.path} value={c.path}>
                {choiceLabel(c)}
              </option>
            ))}
          </select>
        </label>
        {chosen?.kind === 'tmodloader' && (
          <label className="field">
            <span>Copia mod e loro configurazioni da</span>
            <select value={copyModsFrom} onChange={(e) => setCopyModsFrom(e.target.value)}>
              <option value="">Nessuno (server senza mod)</option>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {defaults.data && !effectiveInstall ? (
        <div className="alert alert-warning">
          Nessun gioco installato: installa Terraria (o tModLoader) dalla sezione <strong>Installazioni</strong> qui sotto,
          poi crea il server.
        </div>
      ) : (
        <p className="muted small">
          {chosen?.kind === 'tmodloader'
            ? 'Server tModLoader: avrà le sezioni Mod, Workshop e Modpack.'
            : 'Server Terraria vanilla: per usare le mod potrai passare a tModLoader dalle impostazioni del server, con lo stesso mondo.'}{' '}
          L'installazione è condivisa con gli altri server che la usano: aggiornandola si aggiornano tutti. Il mondo viene
          generato al primo avvio.
        </p>
      )}

      {create.isError && !Object.keys(errors).length && !conflictField && <div className="alert alert-error">{errorMessage(create.error)}</div>}
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={create.isPending || !effectiveInstall}>
          {create.isPending ? 'Creazione…' : 'Crea server'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          Annulla
        </button>
      </div>
    </form>
  )
}

// --- Installazioni (Terraria e tModLoader) -------------------------------------------------------

function InstallationsSection({ servers }: { servers: Server[] }) {
  const installations = useInstallations()

  return (
    <div className="card">
      <h2>Installazioni</h2>
      <p className="muted small">
        Terraria vanilla e tModLoader. Ogni server usa una di queste installazioni (si sceglie dalle sue impostazioni).
      </p>
      {installations.isLoading && <div className="spinner" />}
      {installations.error && <div className="alert alert-error">{errorMessage(installations.error)}</div>}
      <div className="stack">
        {installations.data?.map((i) => <InstallationCard key={i.id} installation={i} servers={servers} />)}
      </div>
    </div>
  )
}

const PHASES: Record<string, string> = {
  download: 'Download',
  extract: 'Estrazione',
  prepare: 'Preparazione',
  stopping: 'Spegnimento dei server',
  swap: 'Sostituzione',
  starting: 'Riavvio dei server',
}

const OTHER_VERSION = '__other'

function InstallationCard({ installation, servers }: { installation: Installation; servers: Server[] }) {
  const releases = useReleases(installation.kind)
  const { updateTml, recreateWorld } = useAdminServerActions()
  const [version, setVersion] = useState('')
  const [customVersion, setCustomVersion] = useState('')
  const [restartServers, setRestartServers] = useState(true)
  const [confirm, setConfirm] = useState<{ version: string } | { backup: string; label: string } | null>(null)
  const job = installation.job
  const running = job !== null && job.phase !== 'done' && job.phase !== 'error'
  const label = GAME_LABEL[installation.kind]
  const isTerraria = installation.kind === 'terraria'

  const latestStable = releases.data?.find((r) => !r.prerelease)
  const selected = version === OTHER_VERSION ? customVersion.trim() : version || latestStable?.version || ''
  const affected = servers.filter((s) => installation.servers.some((x) => x.id === s.id) && s.state !== 'stopped')
  const players = affected.reduce((sum, s) => sum + s.players.online, 0)
  const updateAvailable =
    latestStable && installation.installed && installation.version && compareVersions(latestStable.version, installation.version) > 0

  // Mondi salvati con una versione più recente di quella che si sta per installare
  const confirmRelease = confirm && 'version' in confirm ? releases.data?.find((r) => r.version === confirm.version) : undefined
  const newerWorlds = installation.servers.filter((s) => olderThanWorld(confirmRelease?.worldRelease, s.worldRelease))

  const start = () => {
    if (!confirm) return
    updateTml.mutate(
      { id: installation.id, restartServers, ...('version' in confirm ? { version: confirm.version } : { backup: confirm.backup }) },
      { onSettled: () => setConfirm(null) },
    )
  }

  return (
    <article className="pack">
      <header>
        <div>
          <strong>{label}</strong> <span className="muted small mono">{installation.path}</span>
          <div className="muted small">
            {installation.installed ? (
              <>
                Versione installata: <strong>{installation.version ?? 'sconosciuta'}</strong>
                {!isTerraria && installation.gameVersion && ` (basata su Terraria ${installation.gameVersion})`}
                {installation.servers.length > 0 ? ` · usata da ${installation.servers.map((s) => s.name).join(', ')}` : ' · nessun server la usa'}
              </>
            ) : isTerraria ? (
              'Terraria non è ancora installato: scegli una versione e installala per creare server vanilla.'
            ) : (
              'tModLoader non è ancora installato: installalo per creare server con le mod (o farci passare quelli vanilla).'
            )}
          </div>
        </div>
      </header>

      {job && (
        <div className={`alert ${job.phase === 'error' ? 'alert-error' : job.phase === 'done' ? 'alert-success' : 'alert-warning'}`}>
          <div>
            {running && <strong>{PHASES[job.phase] ?? job.phase}: </strong>}
            {job.message}
            {job.error && <> — {job.error}</>}
          </div>
          {running && job.progress !== null && (
            <div className="progress">
              <div style={{ width: `${Math.round(job.progress * 100)}%` }} />
            </div>
          )}
          {!running && job.finishedAt && <div className="muted small">{formatDate(job.finishedAt)}</div>}
        </div>
      )}

      {!running && (
        <>
          <div className="form-inline">
            <label className="field">
              <span>Versione da installare</span>
              <select value={version || selected} onChange={(e) => setVersion(e.target.value)} disabled={!releases.data && !isTerraria}>
                {releases.data?.map((r, index) => (
                  <option key={r.version} value={r.version}>
                    {r.version}
                    {r.prerelease ? ' (beta)' : ''}
                    {isTerraria && index === 0 ? ' (ultima)' : ''}
                    {installation.installed && r.version === installation.version ? ' — installata' : ''}
                    {r.publishedAt ? ` · ${formatDate(r.publishedAt)}` : ''}
                  </option>
                ))}
                {isTerraria && <option value={OTHER_VERSION}>Altra versione…</option>}
              </select>
            </label>
            {version === OTHER_VERSION && (
              <label className="field">
                <span>Versione (es. 1.4.4.9)</span>
                <input pattern="1(\.\d){3,5}" placeholder="1.4.4.9" value={customVersion} onChange={(e) => setCustomVersion(e.target.value)} />
              </label>
            )}
            {installation.servers.length > 0 && (
              <label className="checkbox">
                <input type="checkbox" checked={restartServers} onChange={(e) => setRestartServers(e.target.checked)} />
                <span>Riaccendi i server dopo l'aggiornamento</span>
              </label>
            )}
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={
                !selected ||
                (version === OTHER_VERSION && !/^1(\.\d){3,5}$/.test(selected)) ||
                (installation.installed && selected === installation.version) ||
                updateTml.isPending
              }
              onClick={() => setConfirm({ version: selected })}
            >
              {installation.installed ? 'Aggiorna' : 'Installa'}
            </button>
          </div>
          {releases.error && <p className="error-text">Versioni non disponibili: {errorMessage(releases.error)}</p>}
          {updateAvailable && (
            <p className="small">
              È disponibile la versione {isTerraria ? '' : 'stabile '}
              <strong>{latestStable.version}</strong>.{' '}
              <a href={latestStable.url} target="_blank" rel="noreferrer">
                Note di rilascio
              </a>
              {isTerraria && ' I giocatori devono aggiornare Terraria alla stessa versione per entrare.'}
            </p>
          )}

          {installation.backups.length > 0 && (
            <>
              <h4>Versioni precedenti (backup)</h4>
              <ul className="upload-list">
                {installation.backups.map((b) => (
                  <li key={b.path} className="upload-row">
                    <span>
                      <strong>{b.version ?? '?'}</strong> <span className="muted small mono">{b.path}</span>{' '}
                      <span className="muted small">{formatDate(b.modifiedAt)}</span>
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={updateTml.isPending}
                      onClick={() => setConfirm({ backup: b.path, label: b.version ?? b.path })}
                    >
                      Torna a questa versione
                    </button>
                  </li>
                ))}
              </ul>
              <p className="muted small">Dopo ogni aggiornamento si tengono le ultime 2 versioni precedenti.</p>
            </>
          )}
        </>
      )}

      {confirm && (
        <div className="alert alert-warning">
          <p>
            {'version' in confirm
              ? installation.installed
                ? `Aggiornare ${label} alla versione ${confirm.version}?`
                : `Installare ${label} ${confirm.version}?`
              : `Tornare alla versione ${confirm.label}?`}{' '}
            {!installation.installed ? null : affected.length > 0 ? (
              <>
                Verranno spenti (salvando il mondo) {affected.map((s) => s.name).join(', ')}
                {players > 0 && <strong> — ci sono {players} giocatori connessi</strong>}
                {restartServers ? ', poi riaccesi.' : ' e resteranno spenti.'}
              </>
            ) : (
              'Nessun server acceso.'
            )}
          </p>
          {newerWorlds.length > 0 && confirmRelease?.worldRelease && (
            <div className="small">
              <p>
                <strong>Attenzione:</strong> questi mondi sono stati salvati con una versione più recente di{' '}
                {worldVersionLabel(confirmRelease.worldRelease)} e potrebbero non aprirsi o far andare in crash il server.
                Puoi ricrearli da capo (il mondo attuale va nel cestino) oppure installare comunque.
              </p>
              <ul className="upload-list">
                {newerWorlds.map((w) => {
                  const on = servers.some((s) => s.id === w.id && s.state !== 'stopped')
                  return (
                    <li key={w.id} className="upload-row">
                      <span>
                        <strong>{w.name}</strong> — {worldVersionLabel(w.worldRelease ?? 0)}
                      </span>
                      <button
                        type="button"
                        className="btn btn-danger-outline btn-sm"
                        disabled={on || recreateWorld.isPending}
                        title={on ? 'Spegni il server prima di ricreare il mondo' : 'Il mondo attuale va nel cestino del server'}
                        onClick={() => recreateWorld.mutate(w.id)}
                      >
                        Ricrea il mondo da capo
                      </button>
                    </li>
                  )
                })}
              </ul>
              {recreateWorld.isError && <p className="error-text">{errorMessage(recreateWorld.error)}</p>}
            </div>
          )}
          <p className="small">
            {installation.installed &&
              (isTerraria
                ? 'I mondi non vengono toccati. I giocatori devono usare la stessa versione di Terraria del server.'
                : 'Mondi e mod non vengono toccati; le mod potrebbero richiedere un aggiornamento per la nuova versione.')}
            {'version' in confirm && confirmRelease?.size ? ` Download di circa ${formatBytes(confirmRelease.size)}.` : ''}
          </p>
          <div className="btn-row">
            <button type="button" className="btn btn-warning btn-sm" disabled={updateTml.isPending} onClick={start}>
              {newerWorlds.length > 0 ? 'Installa comunque' : 'Conferma'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>
              Annulla
            </button>
          </div>
        </div>
      )}
      {updateTml.isError && <div className="alert alert-error">{errorMessage(updateTml.error)}</div>}
    </article>
  )
}

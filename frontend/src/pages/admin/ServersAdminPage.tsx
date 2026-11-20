import { type FormEvent, useState } from 'react'
import { Link } from 'react-router-dom'
import StateBadge from '../../components/StateBadge'
import { PickedHint } from '../../components/InstallationPicker'
import { useInstallationPicker } from '../../lib/installationPicker'
import {
  compareVersions,
  type CreatedServer,
  type NewServer,
  olderThanWorld,
  useAdminServerActions,
  useInstallations,
  useReleases,
  useServerDefaults,
  worldVersionLabel,
} from '../../lib/admin'
import { errorMessage, fieldErrors } from '../../lib/api'
import { formatBytes, formatDate } from '../../lib/format'
import { useServers } from '../../lib/servers'
import { type Game, GAME_LABEL, type Installation, type Server } from '../../lib/types'
import { t, tn } from '../../i18n'

export default function ServersAdminPage() {
  const [creating, setCreating] = useState(false)
  const servers = useServers()

  return (
    <section>
      <div className="page-header">
        <h1>{t('Server management')}</h1>
        {!creating && (
          <div className="btn-row">
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              + {t('New server')}
            </button>
          </div>
        )}
      </div>

      {creating && <NewServerForm servers={servers.data ?? []} onDone={() => setCreating(false)} />}

      <div className="card">
        <h2>{t('Servers')}</h2>
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
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removedDir, setRemovedDir] = useState<string | null>(null)
  const { remove } = useAdminServerActions()

  if (removedDir) {
    return (
      <div className="alert alert-success">
        {tn('{server} was removed from the panel. Its files are still in {dir}.', { server: server.name, dir: <span className="mono">{removedDir}</span> })}
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
            id <span className="mono">{server.id}</span> · {t('port {port}', { port: server.port })} ·{' '}
            {t('max {count} players', { count: server.players.max })} ·{' '}
            {server.hasPassword ? t('with password') : <span className="error-text">{t('without password')}</span>}
            {` · ${GAME_LABEL[server.game]} ${server.version ?? ''}`}
          </div>
        </div>
        <div className="btn-row">
          <Link className="btn btn-sm" to={`/servers/${server.id}/settings`}>
            {t('Settings')}
          </Link>
          {confirmRemove ? (
            <>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={remove.isPending}
                onClick={() => remove.mutate(server.id, { onSuccess: (r) => setRemovedDir(r.saveDir), onSettled: () => setConfirmRemove(false) })}
              >
                {t('Confirm removal')}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmRemove(false)}>
                {t('Cancel')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-danger-outline btn-sm"
              disabled={server.state !== 'stopped'}
              title={server.state !== 'stopped' ? t('Stop the server before removing it') : t('Removes the server from the panel; the files stay on disk')}
              onClick={() => setConfirmRemove(true)}
            >
              {t('Remove')}
            </button>
          )}
        </div>
      </header>
      {confirmRemove && (
        <p className="hint">
          {t(
            'The server is removed from the panel (together with its modpacks and the user permissions). World, mods and configuration stay on disk.',
          )}
        </p>
      )}
      {remove.isError && <div className="alert alert-error">{errorMessage(remove.error)}</div>}
    </article>
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
  const [world, setWorld] = useState<NewServer['world']>({ name: '', size: 2, difficulty: 1, seed: '' })
  const [copyModsFrom, setCopyModsFrom] = useState('')
  const [created, setCreated] = useState<CreatedServer | null>(null)
  const errors = fieldErrors(create.error)
  const conflictField = (create.error as { response?: { data?: { details?: { field?: string } } } } | null)?.response?.data?.details?.field

  const effectivePort = port === '' ? (defaults.data?.port ?? 7777) : port
  // Di default i server nascono vanilla (Terraria, installazione principale)
  const { fields: versionFields, picked } = useInstallationPicker(defaults.data?.installations ?? [], null)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!picked) return
    create.mutate(
      {
        id,
        name,
        ...('installDir' in picked.target ? { installDir: picked.target.installDir } : { version: { game: picked.game, version: picked.target.version! } }),
        port: effectivePort,
        maxPlayers,
        password,
        motd,
        world: { ...world, name: world.name || name },
        copyModsFrom: picked.game === 'tmodloader' ? copyModsFrom || null : null,
      },
      { onSuccess: setCreated },
    )
  }

  if (created) {
    return (
      <div className="card">
        <div className="alert alert-success">
          {tn(
            'Server created in {dir}. The world is generated on the first start: it may take a few minutes. Remember to give users their permissions from the Users page.',
            { dir: <span className="mono">{created.saveDir}</span> },
          )}
        </div>
        {created.install && !created.install.error && (
          <div className="alert alert-info">
            {tn(
              'Installing {game} {version}: the server can be started when it is done. Progress is in the {section} section below.',
              {
                game: GAME_LABEL[created.install.game],
                version: created.install.version ?? '',
                section: <strong>{t('Installations')}</strong>,
              },
            )}
          </div>
        )}
        {created.install?.error && (
          <div className="alert alert-warning">
            {tn('{game} was not installed: {error}. Install it from the {section} section below before starting the server.', {
              game: GAME_LABEL[created.install.game],
              error: created.install.error,
              section: <strong>{t('Installations')}</strong>,
            })}
          </div>
        )}
        <div className="btn-row">
          <Link className="btn btn-primary btn-sm" to={`/servers/${created.id}`}>
            {t('Open the server')}
          </Link>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
            {t('Close')}
          </button>
        </div>
      </div>
    )
  }

  const fieldError = (key: string) => errors[key] ?? (conflictField === key ? errorMessage(create.error) : undefined)

  return (
    <form className="card pack-form" onSubmit={submit}>
      <h2>{t('New server')}</h2>
      <div className="form-inline">
        <label className="field">
          <span>{t('Name')}</span>
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
          <span>{t('Id (in URLs and in the folder name)')}</span>
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
          <span>{t('Port')}</span>
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
                {t('Available ports: {min}–{max}', { min: defaults.data.ports.min, max: defaults.data.ports.max })}
              </span>
            )
          )}
        </label>
        <label className="field">
          <span>{t('Max players')}</span>
          <input type="number" required min={1} max={255} value={maxPlayers} onChange={(e) => setMaxPlayers(Number(e.target.value))} />
        </label>
        <label className="field">
          <span>{t('Password (recommended)')}</span>
          <input maxLength={64} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          {fieldError('password') && <span className="error-text">{fieldError('password')}</span>}
        </label>
        <label className="field">
          <span>{t('Welcome message')}</span>
          <input maxLength={200} value={motd} onChange={(e) => setMotd(e.target.value)} />
        </label>
      </div>

      <h3>{t('World')}</h3>
      <div className="form-inline">
        <label className="field">
          <span>{t('World name')}</span>
          <input
            maxLength={40}
            pattern="[A-Za-z0-9 _'\-]{1,40}"
            placeholder={name || t('Same as the server')}
            value={world.name}
            onChange={(e) => setWorld({ ...world, name: e.target.value })}
          />
          {fieldError('world.name') && <span className="error-text">{fieldError('world.name')}</span>}
        </label>
        <label className="field">
          <span>{t('Size')}</span>
          <select value={world.size} onChange={(e) => setWorld({ ...world, size: Number(e.target.value) as 1 | 2 | 3 })}>
            <option value={1}>{t('Small')}</option>
            <option value={2}>{t('Medium')}</option>
            <option value={3}>{t('Large')}</option>
          </select>
        </label>
        <label className="field">
          <span>{t('Difficulty')}</span>
          <select value={world.difficulty} onChange={(e) => setWorld({ ...world, difficulty: Number(e.target.value) as 0 | 1 | 2 | 3 })}>
            <option value={0}>{t('Classic')}</option>
            <option value={1}>{t('Expert')}</option>
            <option value={2}>{t('Master')}</option>
            <option value={3}>{t('Journey')}</option>
          </select>
        </label>
        <label className="field">
          <span>{t('Seed (optional)')}</span>
          <input maxLength={64} value={world.seed} onChange={(e) => setWorld({ ...world, seed: e.target.value })} />
        </label>
      </div>

      <h3>{t('Game and version')}</h3>
      <div className="form-inline">
        {versionFields}
        {picked?.game === 'tmodloader' && (
          <label className="field">
            <span>{t('Copy mods and their configs from')}</span>
            <select value={copyModsFrom} onChange={(e) => setCopyModsFrom(e.target.value)}>
              <option value="">{t('None (server without mods)')}</option>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {picked?.toInstall && (
        <div className="alert alert-info">
          {t(
            '{game} needs to be installed: creating the server starts the installation automatically (a few minutes), and the server can be started when it is done.',
            { game: GAME_LABEL[picked.game] },
          )}
        </div>
      )}
      <p className="muted small">
        <PickedHint picked={picked} />{' '}
        {picked?.game === 'tmodloader'
          ? t('tModLoader server: it will have the Mods, Workshop and Modpack sections.')
          : picked?.game === 'tshock'
            ? t(
                'TShock server: vanilla Terraria with plugins, players join with regular Terraria. TShock configuration and plugins are in the SaveData folder of the server (Files section: tshock/ and ServerPlugins/); on the first start the console shows the code for /setup.',
              )
            : t('Vanilla Terraria server: you can switch to TShock or tModLoader from the server settings, with the same world.')}{' '}
        {t('The world is generated on the first start.')}
      </p>

      {create.isError && !Object.keys(errors).length && !conflictField && <div className="alert alert-error">{errorMessage(create.error)}</div>}
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={create.isPending || !picked}>
          {create.isPending ? t('Creating…') : t('Create server')}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          {t('Cancel')}
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
      <h2>{t('Installations')}</h2>
      <p className="muted small">
        {t(
          'Vanilla Terraria, TShock and tModLoader. Each game has a main, shared installation (updating it updates all the servers that use it), and pinned versions, which are never updated: a server on a pinned version is updated on its own, by switching to another version. Each server picks its own from the Overview. Once a day new versions are checked: the notices show up at the top of the pages.',
        )}
      </p>
      {installations.isLoading && <div className="spinner" />}
      {installations.error && <div className="alert alert-error">{errorMessage(installations.error)}</div>}
      <div className="stack">
        {installations.data?.map((i) => (
          <InstallationCard
            key={i.id}
            installation={i}
            servers={servers}
            hasPinned={installations.data.some((x) => x.pinned && x.kind === i.kind)}
          />
        ))}
        {installations.data && <AddVersion installations={installations.data} />}
      </div>
    </div>
  )
}

/** Versioni fisse di Terraria, TShock o tModLoader: server su versioni diverse, aggiornati uno per uno. */
function AddVersion({ installations }: { installations: Installation[] }) {
  const [game, setGame] = useState<Game>('terraria')
  const releases = useReleases(game)
  const { addVersion } = useAdminServerActions()
  const [version, setVersion] = useState('')
  const [customVersion, setCustomVersion] = useState('')
  const present = new Set(installations.filter((i) => i.kind === game && i.pinned).map((i) => i.version ?? i.job?.toVersion))
  const available = releases.data?.filter((r) => !present.has(r.version)) ?? []
  const isTerraria = game === 'terraria'
  const selected = version === OTHER_VERSION ? customVersion.trim() : version || available.find((r) => !r.prerelease)?.version || available[0]?.version || ''
  const valid = (isTerraria && version === OTHER_VERSION ? /^1(\.\d){3,5}$/.test(selected) : selected !== '') && !present.has(selected)

  return (
    <article className="pack">
      <header>
        <div>
          <strong>{t('Add a pinned version')}</strong>
          <div className="muted small">
            {t(
              'A pinned version is never updated: the servers that use it stay on it until you switch them to another one (from the server Overview, where new versions can also be installed on the fly). It can be removed when no server uses it.',
            )}
          </div>
        </div>
      </header>
      <div className="form-inline">
        <label className="field field-narrow">
          <span>{t('Game')}</span>
          <select
            value={game}
            onChange={(e) => {
              setGame(e.target.value as Game)
              setVersion('')
            }}
          >
            {(['terraria', 'tshock', 'tmodloader'] as const).map((g) => (
              <option key={g} value={g}>
                {GAME_LABEL[g]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('Version')}</span>
          <select value={version || selected} onChange={(e) => setVersion(e.target.value)}>
            {available.map((r) => (
              <option key={r.version} value={r.version}>
                {r.version}
                {r.prerelease ? ' (beta)' : ''}
                {game === 'tshock' && r.gameVersion ? ` (Terraria ${r.gameVersion})` : ''}
                {r.publishedAt ? ` · ${formatDate(r.publishedAt)}` : ''}
              </option>
            ))}
            {isTerraria && <option value={OTHER_VERSION}>{t('Other version…')}</option>}
          </select>
        </label>
        {isTerraria && (version === OTHER_VERSION || (!available.length && !releases.isLoading)) && (
          <label className="field">
            <span>{t('Version (e.g. {example})', { example: '1.4.3.6' })}</span>
            <input
              pattern="1(\.\d){3,5}"
              placeholder="1.4.3.6"
              value={customVersion}
              onChange={(e) => {
                setVersion(OTHER_VERSION)
                setCustomVersion(e.target.value)
              }}
            />
          </label>
        )}
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!valid || addVersion.isPending}
          onClick={() => addVersion.mutate({ game, version: selected }, { onSuccess: () => setVersion('') })}
        >
          {t('Add')}
        </button>
      </div>
      {isTerraria && <p className="muted small">{t('terraria.org has the versions from 1.4.1.2 onwards.')}</p>}
      {releases.error && <p className="error-text">{t('Versions not available: {error}', { error: errorMessage(releases.error) })}</p>}
      {addVersion.isError && <div className="alert alert-error">{errorMessage(addVersion.error)}</div>}
    </article>
  )
}

const phaseLabel = (phase: string): string | undefined =>
  ({
    download: t('Download'),
    extract: t('Extraction'),
    prepare: t('Preparation'),
    stopping: t('Stopping the servers'),
    swap: t('Replacement'),
    starting: t('Restarting the servers'),
  })[phase]

const OTHER_VERSION = '__other'

function InstallationCard({ installation, servers, hasPinned }: { installation: Installation; servers: Server[]; hasPinned: boolean }) {
  const releases = useReleases(installation.kind, !installation.pinned)
  const { updateTml, recreateWorld, removeInstallation } = useAdminServerActions()
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
          <strong>
            {label}
            {installation.pinned && ` ${installation.version ?? installation.job?.toVersion ?? ''}`}
          </strong>{' '}
          {installation.pinned ? (
            <span className="muted small">{t('pinned version')}</span>
          ) : (
            hasPinned && installation.managed && <span className="muted small">{t('main, shared')}</span>
          )}{' '}
          <span className="muted small mono">{installation.path}</span>
          <div className="muted small">
            {installation.pinned && !installation.installed ? (
              installation.job?.phase === 'error' ? t('Installation failed.') : t('Installing…')
            ) : installation.installed ? (
              <>
                {t('Installed version:')} <strong>{installation.version ?? t('unknown')}</strong>
                {installation.kind === 'tmodloader' && installation.gameVersion && ` ${t('(based on Terraria {version})', { version: installation.gameVersion })}`}
                {installation.kind === 'tshock' && installation.gameVersion && ` ${t('(for Terraria {version})', { version: installation.gameVersion })}`}
                {installation.servers.length > 0
                  ? ` · ${t('used by {servers}', { servers: installation.servers.map((s) => s.name).join(', ') })}`
                  : ` · ${t('no server uses it')}`}
              </>
            ) : isTerraria ? (
              t('Terraria is not installed yet: pick a version and install it to create vanilla servers.')
            ) : installation.kind === 'tshock' ? (
              t(
                'TShock is not installed yet: install it to create servers with plugins (or to switch the vanilla ones to it). The .NET runtime it needs is downloaded along with it.',
              )
            ) : (
              t('tModLoader is not installed yet: install it to create servers with mods (or to switch the vanilla ones to it).')
            )}
          </div>
        </div>
        {installation.pinned && !running && (
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-danger-outline btn-sm"
              disabled={installation.servers.length > 0 || removeInstallation.isPending}
              title={installation.servers.length > 0 ? t('First switch the servers that use it to another version') : t('Deletes this version from disk')}
              onClick={() => removeInstallation.mutate(installation.id)}
            >
              {t('Remove')}
            </button>
          </div>
        )}
      </header>
      {removeInstallation.isError && <div className="alert alert-error">{errorMessage(removeInstallation.error)}</div>}

      {job && (
        <div className={`alert ${job.phase === 'error' ? 'alert-error' : job.phase === 'done' ? 'alert-success' : 'alert-warning'}`}>
          <div>
            {running && <strong>{phaseLabel(job.phase) ?? job.phase}: </strong>}
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

      {!running && !installation.pinned && (
        <>
          <div className="form-inline">
            <label className="field">
              <span>{t('Version to install')}</span>
              <select value={version || selected} onChange={(e) => setVersion(e.target.value)} disabled={!releases.data && !isTerraria}>
                {releases.data?.map((r, index) => (
                  <option key={r.version} value={r.version}>
                    {r.version}
                    {r.prerelease ? ' (beta)' : ''}
                    {isTerraria && index === 0 ? ` (${t('latest')})` : ''}
                    {installation.kind === 'tshock' && r.gameVersion ? ` · Terraria ${r.gameVersion}` : ''}
                    {installation.installed && r.version === installation.version ? ` — ${t('installed')}` : ''}
                    {r.publishedAt ? ` · ${formatDate(r.publishedAt)}` : ''}
                  </option>
                ))}
                {isTerraria && <option value={OTHER_VERSION}>{t('Other version…')}</option>}
              </select>
            </label>
            {version === OTHER_VERSION && (
              <label className="field">
                <span>{t('Version (e.g. {example})', { example: '1.4.4.9' })}</span>
                <input pattern="1(\.\d){3,5}" placeholder="1.4.4.9" value={customVersion} onChange={(e) => setCustomVersion(e.target.value)} />
              </label>
            )}
            {installation.servers.length > 0 && (
              <label className="checkbox">
                <input type="checkbox" checked={restartServers} onChange={(e) => setRestartServers(e.target.checked)} />
                <span>{t('Start the servers again after the update')}</span>
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
              {installation.installed ? t('Update') : t('Install')}
            </button>
          </div>
          {releases.error && <p className="error-text">{t('Versions not available: {error}', { error: errorMessage(releases.error) })}</p>}
          {updateAvailable && (
            <p className="small">
              {tn(isTerraria ? 'Version {version} is available.' : 'Stable version {version} is available.', {
                version: <strong>{latestStable.version}</strong>,
              })}{' '}
              <a href={latestStable.url} target="_blank" rel="noreferrer">
                {t('Release notes')}
              </a>
              {isTerraria && ` ${t('Players need to update Terraria to the same version to join.')}`}
              {installation.kind === 'tshock' &&
                latestStable.gameVersion &&
                latestStable.gameVersion !== installation.gameVersion &&
                ` ${t('It supports Terraria {version}: players need that version to join.', { version: latestStable.gameVersion })}`}
            </p>
          )}

          {installation.backups.length > 0 && (
            <>
              <h4>{t('Previous versions (backups)')}</h4>
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
                      {t('Go back to this version')}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="muted small">{t('After each update the last 2 previous versions are kept.')}</p>
            </>
          )}
        </>
      )}

      {confirm && (
        <div className="alert alert-warning">
          <p>
            {'version' in confirm
              ? installation.installed
                ? t('Update {game} to version {version}?', { game: label, version: confirm.version })
                : t('Install {game} {version}?', { game: label, version: confirm.version })
              : t('Go back to version {version}?', { version: confirm.label })}{' '}
            {!installation.installed ? null : affected.length > 0 ? (
              <>
                {t('These will be stopped (saving the world): {servers}', { servers: affected.map((s) => s.name).join(', ') })}
                {players > 0 && <strong> — {t('{count} players connected', { count: players })}</strong>}
                {restartServers ? t(', then started again.') : t(', and will stay stopped.')}
              </>
            ) : (
              t('No server running.')
            )}
          </p>
          {newerWorlds.length > 0 && confirmRelease?.worldRelease && (
            <div className="small">
              <p>
                <strong>{t('Warning:')}</strong>{' '}
                {t(
                  'these worlds were saved with a newer version than {version} and might not open or might crash the server. You can recreate them from scratch (the current world goes to the trash) or install anyway.',
                  { version: worldVersionLabel(confirmRelease.worldRelease) },
                )}
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
                        title={on ? t('Stop the server before recreating the world') : t('The current world goes to the server trash')}
                        onClick={() => recreateWorld.mutate(w.id)}
                      >
                        {t('Recreate the world from scratch')}
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
                ? t('Worlds are not touched. Players need the same Terraria version as the server.')
                : installation.kind === 'tshock'
                  ? t('Worlds, TShock data and plugins are not touched; plugins might need an updated version.')
                  : t('Worlds and mods are not touched; mods might need an update for the new version.'))}
            {'version' in confirm && confirmRelease?.size ? ` ${t('Download of about {size}.', { size: formatBytes(confirmRelease.size) })}` : ''}
          </p>
          <div className="btn-row">
            <button type="button" className="btn btn-warning btn-sm" disabled={updateTml.isPending} onClick={start}>
              {newerWorlds.length > 0 ? t('Install anyway') : t('Confirm')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>
              {t('Cancel')}
            </button>
          </div>
        </div>
      )}
      {updateTml.isError && <div className="alert alert-error">{errorMessage(updateTml.error)}</div>}
    </article>
  )
}

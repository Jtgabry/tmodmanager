import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { compareVersions, type Game, GAMES, gameLabel } from './games.js'
import type { ServerManager } from './manager.js'
import { paths } from './paths.js'
import { loadServers, type ServerDefinition } from './registry.js'
import { ServerAdminError, updateServer } from './serverAdmin.js'
import {
  addVersion,
  busy,
  gameVersion,
  type Installation,
  installationJob,
  isInstalled,
  type Job,
  listInstallations,
  listReleases,
  onReleases,
  type Release,
  startJob,
  TmlError,
} from './tml.js'
import { tr } from './i18n.js'

/**
 * Aggiornamenti di Terraria, TShock e tModLoader.
 *
 *  - Controllo giornaliero: al massimo una volta ogni 24 ore (anche tra un riavvio e l'altro dell'agent,
 *    l'ora dell'ultimo controllo sta in data/update-check.json) si legge l'ultima versione stabile di
 *    ogni gioco. Anche gli elenchi scaricati aprendo Gestione server aggiornano questi dati.
 *  - Avvisi per l'amministratore: installazione da aggiornare; Terraria uscito prima di TShock (i server
 *    TShock possono passare a vanilla nel frattempo); TShock arrivato per i server passati a vanilla.
 *  - Passaggio guidato di un server tra TShock e Terraria vanilla: installa o aggiorna ciò che serve,
 *    spegne il server (salvando il mondo), cambia installazione e lo riaccende se era acceso. Mondo,
 *    dati di TShock e plugin restano nel save/ del server.
 */

const CHECK_EVERY = 24 * 60 * 60 * 1000

type Latest = Pick<Release, 'version' | 'gameVersion' | 'url' | 'publishedAt' | 'worldRelease'>

type CheckState = {
  /** Ultimo controllo automatico (null = mai fatto). */
  checkedAt: string | null
  /** Ultima versione stabile di ogni gioco. */
  latest: Partial<Record<Game, Latest>>
  /** Errori dell'ultimo controllo, per gioco. */
  errors: Partial<Record<Game, string>>
}

let state: CheckState | null = null
let writing: Promise<unknown> = Promise.resolve()

async function loadState(): Promise<CheckState> {
  if (state) return state
  try {
    const raw = JSON.parse(await readFile(paths.updateCheck(), 'utf8')) as Partial<CheckState>
    state = { checkedAt: raw.checkedAt ?? null, latest: raw.latest ?? {}, errors: raw.errors ?? {} }
  } catch {
    state = { checkedAt: null, latest: {}, errors: {} }
  }
  return state
}

function saveState() {
  const task = writing.then(async () => {
    if (!state) return
    const file = paths.updateCheck()
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`)
    await rename(tmp, file)
  })
  writing = task.catch(() => undefined)
  return task
}

const latestOf = (releases: Release[]): Latest | null => {
  const release = releases.find((r) => !r.prerelease)
  return release ? { version: release.version, gameVersion: release.gameVersion, url: release.url, publishedAt: release.publishedAt, worldRelease: release.worldRelease } : null
}

/** Ogni elenco di release scaricato (controllo giornaliero o pagina Gestione server) aggiorna l'ultima versione nota. */
onReleases((kind, releases) => {
  const latest = latestOf(releases)
  if (!latest) return
  void loadState().then((s) => {
    s.latest[kind] = latest
    delete s.errors[kind]
    return saveState()
  })
})

/** Controlla le ultime versioni di tutti i giochi, se l'ultimo controllo è di più di 24 ore fa (o `force`). */
export async function checkUpdates(force = false): Promise<CheckState> {
  const s = await loadState()
  if (!force && s.checkedAt && Date.now() - Date.parse(s.checkedAt) < CHECK_EVERY) return s
  for (const game of GAMES) {
    try {
      await listReleases(game, true)
    } catch (err) {
      s.errors[game] = (err as Error).message
    }
  }
  s.checkedAt = new Date().toISOString()
  await saveState()
  return s
}

/** Controllo all'avvio dell'agent (se dovuto) e poi ogni ora si verifica se sono passate 24 ore. */
export function scheduleUpdateChecks(log: { info: (m: string) => void; warn: (m: string) => void }) {
  const tick = () =>
    checkUpdates()
      .then((s) => {
        const failed = Object.entries(s.errors)
        if (failed.length) log.warn(`Controllo aggiornamenti: ${failed.map(([g, e]) => `${g}: ${e}`).join('; ')}`)
      })
      .catch((err: Error) => log.warn(`Controllo aggiornamenti non riuscito: ${err.message}`))
  void tick()
  setInterval(tick, 60 * 60 * 1000).unref()
}

// --- Avvisi ------------------------------------------------------------------------------------

type ServerRef = { id: string; name: string }

export type UpdateNotice =
  | {
      type: 'update'
      id: string
      game: Game
      /** Id dell'installazione da aggiornare. */
      installation: string
      from: string | null
      to: string
      gameVersion: string | null
      url: string
      servers: ServerRef[]
    }
  | {
      /** Server su una versione fissa: è uscita una versione più recente (si aggiorna solo lui). */
      type: 'server-update'
      id: string
      server: ServerRef
      game: Game
      from: string
      to: string
      gameVersion: string | null
      url: string
    }
  | {
      /** È uscita una versione di Terraria che TShock non supporta ancora. */
      type: 'tshock-behind'
      id: string
      terrariaVersion: string
      /** Versione di Terraria supportata dall'ultima TShock. */
      tshockGameVersion: string | null
      servers: ServerRef[]
    }
  | {
      /** Un server passato a vanilla può tornare su TShock: ora supporta la sua versione di Terraria. */
      type: 'tshock-ready'
      id: string
      server: ServerRef
      serverGameVersion: string
      tshockVersion: string
      tshockGameVersion: string
      /** TShock va prima installato o aggiornato (lo fa il passaggio). */
      needsUpdate: boolean
    }

/** Installazione principale (del pannello, non una versione fissa) di un gioco. */
const mainInstallation = (installations: Installation[], game: Game) =>
  installations.find((i) => i.kind === game && i.managed && !i.pinned) ?? null

/** a ≥ b, con b noto (versioni di Terraria). */
const atLeast = (a: string | null | undefined, b: string) => !!a && compareVersions(a, b) >= 0

/** Avvisi calcolati dai dati dell'ultimo controllo e dallo stato attuale di installazioni e server. */
export async function updateNotices(): Promise<{ checkedAt: string | null; notices: UpdateNotice[]; switches: SwitchJob[] }> {
  const s = await loadState()
  const [installations, servers] = await Promise.all([listInstallations(), loadServers()])
  const notices: UpdateNotice[] = []
  const running = (i: Installation) => i.job !== null && i.job.phase !== 'done' && i.job.phase !== 'error'

  for (const installation of installations) {
    const latest = s.latest[installation.kind]
    if (!latest || !installation.managed || installation.pinned || !installation.installed || !installation.version || running(installation)) continue
    if (compareVersions(latest.version, installation.version) <= 0) continue
    notices.push({
      type: 'update',
      id: `update:${installation.id}:${latest.version}`,
      game: installation.kind,
      installation: installation.id,
      from: installation.version,
      to: latest.version,
      gameVersion: latest.gameVersion,
      url: latest.url,
      servers: installation.servers.map(({ id, name }) => ({ id, name })),
    })
  }

  const switching = (serverId: string) => {
    const job = switches.get(serverId)
    return !!job && !finished(job)
  }
  for (const installation of installations.filter((i) => i.pinned && i.installed && i.version)) {
    const latest = s.latest[installation.kind]
    if (!latest || compareVersions(latest.version, installation.version!) <= 0) continue
    for (const server of installation.servers.filter((sv) => !switching(sv.id))) {
      notices.push({
        type: 'server-update',
        id: `server-update:${server.id}:${latest.version}`,
        server: { id: server.id, name: server.name },
        game: installation.kind,
        from: installation.version!,
        to: latest.version,
        gameVersion: latest.gameVersion,
        url: latest.url,
      })
    }
  }

  const terraria = s.latest.terraria?.version ?? null
  const tshock = mainInstallation(installations, 'tshock')
  const latestTshock = s.latest.tshock ?? null
  // Versione di Terraria più recente che TShock supporta (installata o ultima release)
  const tshockSupports = [tshock?.gameVersion, latestTshock?.gameVersion]
    .filter((v): v is string => !!v)
    .sort((a, b) => compareVersions(b, a))[0] ?? null

  const onTshock = servers.filter((sv) => sv.game === 'tshock')
  if (terraria && onTshock.length && tshockSupports && compareVersions(terraria, tshockSupports) > 0) {
    notices.push({
      type: 'tshock-behind',
      id: `tshock-behind:${terraria}`,
      terrariaVersion: terraria,
      tshockGameVersion: tshockSupports,
      servers: onTshock.filter((sv) => !switching(sv.id)).map(({ id, name }) => ({ id, name })),
    })
  }

  for (const server of servers.filter((sv) => sv.game === 'terraria' && sv.awaitingTshock)) {
    const needed = await gameVersion(server.installDir, 'terraria').catch(() => null)
    if (!needed) continue
    const installedOk = tshock?.installed && atLeast(tshock.gameVersion, needed)
    const releaseOk = latestTshock && atLeast(latestTshock.gameVersion, needed)
    if (!installedOk && !releaseOk) continue
    const version = installedOk ? tshock!.version! : latestTshock!.version
    notices.push({
      type: 'tshock-ready',
      id: `tshock-ready:${server.id}:${version}`,
      server: { id: server.id, name: server.name },
      serverGameVersion: needed,
      tshockVersion: version,
      tshockGameVersion: installedOk ? tshock!.gameVersion! : latestTshock!.gameVersion!,
      needsUpdate: !installedOk,
    })
  }

  // Le notifiche dei server in fase di passaggio restano (con il job) finché il passaggio non è finito
  return { checkedAt: s.checkedAt, notices, switches: [...switches.values()] }
}

// --- Passaggio guidato tra TShock e Terraria vanilla ---------------------------------------------

export type SwitchPhase = 'installing' | 'stopping' | 'switching' | 'starting' | 'done' | 'error'

export type SwitchJob = {
  serverId: string
  serverName: string
  from: Game
  to: Game
  /** Versione installata di destinazione (nota quando la sceglie il passaggio). */
  version: string | null
  phase: SwitchPhase
  message: string
  error: string | null
  startedAt: string
  finishedAt: string | null
}

const switches = new Map<string, SwitchJob>()
const finished = (job: SwitchJob) => job.phase === 'done' || job.phase === 'error'

/** Installazione di destinazione e, se va installata o aggiornata prima, il job partito per farlo. */
type Target = { game: Game; dir: string; version: string | null; job: Job | null }

/** Versione fissa di un gioco: già installata, in installazione (si aspetta) o da installare. */
async function versionTarget(game: Game, version: string, manager: ServerManager): Promise<Target> {
  const dir = paths.gameVersion(game, version)
  const running = installationJob(dir)
  if (busy(running)) return { game, dir, version, job: running }
  if (await isInstalled(dir)) return { game, dir, version, job: null }
  return { game, dir, version, job: await addVersion(game, version, manager) }
}

/** Un'installazione esistente; se è una principale non ancora installata, si installa l'ultima versione stabile. */
async function installationTarget(installDir: string, manager: ServerManager): Promise<Target> {
  const installation = (await listInstallations()).find((i) => i.path === installDir)
  if (!installation || (!installation.installed && !installation.managed)) {
    throw new ServerAdminError(tr('Unknown installation'), 422, 'installDir')
  }
  const { kind: game } = installation
  if (busy(installation.job)) return { game, dir: installDir, version: installation.job.toVersion, job: installation.job }
  if (installation.installed) return { game, dir: installDir, version: installation.version, job: null }
  if (installation.pinned) throw new ServerAdminError(tr('This pinned version is not installed: add it again'), 409, 'installDir')
  const latest = latestOf(await listReleases(game))
  if (!latest) throw new ServerAdminError(tr('No stable version of {game} found', { game: gameLabel(game) }), 409)
  return { game, dir: installDir, version: latest.version, job: await startJob(installation, { version: latest.version }, false, manager) }
}

/**
 * Terraria vanilla, all'ultima versione: un'installazione che l'ha già, altrimenti quella principale
 * (installata o aggiornata se nessun server la usa), altrimenti una versione fissa.
 */
async function terrariaTarget(manager: ServerManager): Promise<Target> {
  const s = await loadState()
  const version = s.latest.terraria?.version ?? latestOf(await listReleases('terraria'))?.version
  if (!version) throw new ServerAdminError(tr('No Terraria version found'), 409)
  const installations = await listInstallations()
  const ready = installations.find((i) => i.kind === 'terraria' && i.installed && i.version === version)
  if (ready) return { game: 'terraria', dir: ready.path, version, job: null }
  const main = mainInstallation(installations, 'terraria')
  if (main && !busy(main.job) && (!main.installed || main.servers.length === 0)) {
    return { game: 'terraria', dir: main.path, version, job: await startJob(main, { version }, false, manager) }
  }
  return versionTarget('terraria', version, manager)
}

/** TShock: quella installata se supporta la versione di Terraria del server, altrimenti si installa/aggiorna l'ultima. */
async function tshockTarget(server: ServerDefinition, manager: ServerManager): Promise<Target> {
  const installations = await listInstallations()
  const main = mainInstallation(installations, 'tshock')
  if (!main) throw new ServerAdminError(tr('TShock installation not found'), 409)
  const needed = await gameVersion(server.installDir, server.game).catch(() => null)
  if (busy(main.job)) return { game: 'tshock', dir: main.path, version: main.job.toVersion, job: main.job }
  if (main.installed && (!needed || atLeast(main.gameVersion, needed))) return { game: 'tshock', dir: main.path, version: main.version, job: null }

  const latest = latestOf(await listReleases('tshock'))
  if (!latest) throw new ServerAdminError(tr('No stable version of {game} found', { game: 'TShock' }), 409)
  if (needed && !atLeast(latest.gameVersion, needed)) {
    throw new ServerAdminError(
      tr('TShock {version} supports Terraria {supported}, but the server is on Terraria {needed}: wait for a newer TShock version', { version: latest.version, supported: latest.gameVersion ?? '?', needed }),
      409,
    )
  }
  if (main.installed && main.version === latest.version) return { game: 'tshock', dir: main.path, version: main.version, job: null }
  return { game: 'tshock', dir: main.path, version: latest.version, job: await startJob(main, { version: latest.version }, true, manager) }
}

/**
 * Destinazione di un passaggio:
 *  - { installDir }: un'installazione esistente (la principale di un gioco non ancora installato si installa);
 *  - { game, version }: una versione fissa, installata se manca (aggiorna solo questo server);
 *  - { game }: Terraria all'ultima versione o TShock che supporta la versione del server (avvisi di aggiornamento);
 *    tModLoader: la sua installazione principale.
 */
export type SwitchRequest = { installDir: string } | { game: Game; version?: string }

async function resolveTarget(server: ServerDefinition, request: SwitchRequest, manager: ServerManager): Promise<Target> {
  if ('installDir' in request) return installationTarget(request.installDir, manager)
  if (request.version) return versionTarget(request.game, request.version, manager)
  if (server.game === request.game) throw new ServerAdminError(tr('{server} is already a {game} server', { server: server.name, game: gameLabel(request.game) }), 409)
  if (request.game === 'terraria') return terrariaTarget(manager)
  if (request.game === 'tshock') return tshockTarget(server, manager)
  return installationTarget(paths.tmlInstall(), manager)
}

/**
 * Passa un server a un'altra installazione o versione (anche di un altro gioco). Prepara (o fa partire
 * l'installazione di) ciò che serve e restituisce subito il job; il resto prosegue in background e si
 * segue con updateNotices(): attesa dell'installazione, spegnimento (salvando il mondo), cambio, riaccensione.
 */
export async function switchGame(id: string, request: SwitchRequest, manager: ServerManager): Promise<SwitchJob> {
  const server = (await loadServers()).find((s) => s.id === id)
  if (!server) throw new ServerAdminError(tr('Server not found'), 404)
  const current = switches.get(id)
  if (current && !finished(current)) throw new ServerAdminError(tr('Switch of {server} already in progress', { server: server.name }), 409)
  const status = await manager.status(server)
  if (status.operation) throw new ServerAdminError(tr('Operation in progress on {server}: try again shortly', { server: server.name }), 409)
  if (status.state !== 'stopped' && !status.managed) {
    throw new ServerAdminError(tr('{server} is running outside the panel: stop it first', { server: server.name }), 409)
  }
  if ('installDir' in request && request.installDir === server.installDir) {
    throw new ServerAdminError(tr('{server} already uses this installation', { server: server.name }), 409, 'installDir')
  }
  if ('game' in request && request.version && paths.gameVersion(request.game, request.version) === server.installDir) {
    throw new ServerAdminError(tr('{server} already uses {game} {version}', { server: server.name, game: gameLabel(request.game), version: request.version ?? '' }), 409)
  }

  let target: Target
  try {
    target = await resolveTarget(server, request, manager)
  } catch (err) {
    if (err instanceof TmlError) throw new ServerAdminError(err.message, err.status === 404 ? 404 : 409)
    throw err
  }
  const to = target.game

  const job: SwitchJob = {
    serverId: id,
    serverName: server.name,
    from: server.game,
    to,
    version: target.version,
    phase: target.job ? 'installing' : 'stopping',
    message: target.job ? tr('Installing {game} {version}…', { game: gameLabel(to), version: target.version ?? '' }) : tr('Preparing…'),
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  }
  switches.set(id, job)
  manager.blockServer(id, tr('Switch to {game} in progress: try again when it is finished', { game: gameLabel(to) }))
  runSwitch(job, server, target, manager)
    .catch((err: Error) => {
      job.phase = 'error'
      job.error = err.message
      job.message = tr('Switch to {game} failed', { game: gameLabel(to) })
      job.finishedAt = new Date().toISOString()
    })
    .finally(() => manager.unblockServer(id))
  return job
}

async function runSwitch(job: SwitchJob, server: ServerDefinition, target: Target, manager: ServerManager) {
  if (target.job) {
    // L'installazione prosegue nel suo job: si aspetta che finisca
    for (;;) {
      const install = installationJob(target.dir)
      if (!install || install.phase === 'error') throw new Error(tr('Installation failed: {error}', { error: install?.error ?? tr('interrupted') }))
      if (install.phase === 'done') break
      job.message = tr('Installing {game} {version}: {progress}', { game: gameLabel(job.to), version: target.version ?? '', progress: install.message })
      await sleep(1000)
    }
  }

  const wasRunning = (await manager.status(server)).state !== 'stopped'
  if (wasRunning) {
    job.phase = 'stopping'
    job.message = tr('Stopping {server} (saving the world)…', { server: server.name })
    await manager.runBlocking(server, 'stop')
  }

  job.phase = 'switching'
  job.message = tr('Switching to {game}…', { game: gameLabel(job.to) })
  await updateServer(server.id, { installDir: target.dir }, manager)

  if (wasRunning) {
    job.phase = 'starting'
    job.message = tr('Starting {server}…', { server: server.name })
    const updated = (await loadServers()).find((s) => s.id === server.id)
    if (updated) await manager.runBlocking(updated, 'start')
  }

  job.phase = 'done'
  const now = `${gameLabel(job.to)}${target.version ? ` ${target.version}` : ''}`
  job.message = wasRunning
    ? tr('{server} is now a {game} server and has been started again.', { server: server.name, game: now })
    : tr('{server} is now a {game} server.', { server: server.name, game: now })
  job.finishedAt = new Date().toISOString()
}

/** Solo per i test. */
export function resetUpdateState() {
  state = null
  switches.clear()
}

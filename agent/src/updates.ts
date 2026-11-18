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
  addTerrariaVersion,
  gameVersion,
  type Installation,
  installationJob,
  type Job,
  listInstallations,
  listReleases,
  onReleases,
  type Release,
  startJob,
  TmlError,
} from './tml.js'

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

/** Installazione principale (del pannello, non una versione aggiuntiva) di un gioco. */
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
      servers: onTshock.filter((sv) => !switches.has(sv.id) || finished(switches.get(sv.id)!)).map(({ id, name }) => ({ id, name })),
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

export const SWITCH_TARGETS = ['terraria', 'tshock'] as const
export type SwitchTarget = (typeof SWITCH_TARGETS)[number]

/** Installazione di destinazione e, se va installata o aggiornata prima, il job partito per farlo. */
type Target = { dir: string; version: string | null; job: Job | null }

/**
 * Terraria vanilla, all'ultima versione: un'installazione che l'ha già, altrimenti quella principale
 * (installata o aggiornata se nessun server la usa), altrimenti una versione aggiuntiva.
 */
async function terrariaTarget(manager: ServerManager): Promise<Target> {
  const s = await loadState()
  const version = s.latest.terraria?.version ?? latestOf(await listReleases('terraria'))?.version
  if (!version) throw new ServerAdminError('Nessuna versione di Terraria trovata', 409)
  const installations = await listInstallations()
  const ready = installations.find((i) => i.kind === 'terraria' && i.installed && i.version === version)
  if (ready) return { dir: ready.path, version, job: null }
  const main = mainInstallation(installations, 'terraria')
  if (main && (!main.installed || main.servers.length === 0)) {
    return { dir: main.path, version, job: await startJob(main, { version }, false, manager) }
  }
  const job = await addTerrariaVersion(version, manager)
  return { dir: job.installDir, version, job }
}

/** TShock: quella installata se supporta la versione di Terraria del server, altrimenti si installa/aggiorna l'ultima. */
async function tshockTarget(server: ServerDefinition, manager: ServerManager): Promise<Target> {
  const installations = await listInstallations()
  const main = mainInstallation(installations, 'tshock')
  if (!main) throw new ServerAdminError('Installazione di TShock non trovata', 409)
  const needed = await gameVersion(server.installDir, server.game).catch(() => null)
  if (main.installed && (!needed || atLeast(main.gameVersion, needed))) return { dir: main.path, version: main.version, job: null }

  const latest = latestOf(await listReleases('tshock'))
  if (!latest) throw new ServerAdminError('Nessuna versione stabile di TShock trovata', 409)
  if (needed && !atLeast(latest.gameVersion, needed)) {
    throw new ServerAdminError(
      `TShock ${latest.version} supporta Terraria ${latest.gameVersion ?? '?'}, ma il server è su Terraria ${needed}: aspetta una versione di TShock più recente`,
      409,
    )
  }
  if (main.installed && main.version === latest.version) return { dir: main.path, version: main.version, job: null }
  return { dir: main.path, version: latest.version, job: await startJob(main, { version: latest.version }, true, manager) }
}

/**
 * Passa un server a Terraria vanilla o a TShock. Prepara (o fa partire l'installazione di) ciò che serve
 * e restituisce subito il job; il resto prosegue in background e si segue con updateNotices().
 */
export async function switchGame(id: string, to: SwitchTarget, manager: ServerManager): Promise<SwitchJob> {
  const server = (await loadServers()).find((s) => s.id === id)
  if (!server) throw new ServerAdminError('Server non trovato', 404)
  if (server.game === to) throw new ServerAdminError(`${server.name} è già un server ${gameLabel(to)}`, 409)
  const current = switches.get(id)
  if (current && !finished(current)) throw new ServerAdminError(`Passaggio di ${server.name} già in corso`, 409)
  const status = await manager.status(server)
  if (status.operation) throw new ServerAdminError(`Operazione in corso su ${server.name}: riprova tra poco`, 409)
  if (status.state !== 'stopped' && !status.managed) {
    throw new ServerAdminError(`${server.name} è acceso fuori dal pannello: spegnilo prima`, 409)
  }

  let target: Target
  try {
    target = to === 'terraria' ? await terrariaTarget(manager) : await tshockTarget(server, manager)
  } catch (err) {
    if (err instanceof TmlError) throw new ServerAdminError(err.message, err.status === 404 ? 404 : 409)
    throw err
  }

  const job: SwitchJob = {
    serverId: id,
    serverName: server.name,
    from: server.game,
    to,
    version: target.version,
    phase: target.job ? 'installing' : 'stopping',
    message: target.job ? `Installazione di ${gameLabel(to)} ${target.version ?? ''}…` : 'Preparazione…',
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  }
  switches.set(id, job)
  manager.blockServer(id, `Passaggio a ${gameLabel(to)} in corso: riprova quando è finito`)
  runSwitch(job, server, target, manager)
    .catch((err: Error) => {
      job.phase = 'error'
      job.error = err.message
      job.message = `Passaggio a ${gameLabel(to)} non riuscito`
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
      if (!install || install.phase === 'error') throw new Error(`Installazione non riuscita: ${install?.error ?? 'interrotta'}`)
      if (install.phase === 'done') break
      job.message = `Installazione di ${gameLabel(job.to)} ${target.version ?? ''}: ${install.message}`
      await sleep(1000)
    }
  }

  const wasRunning = (await manager.status(server)).state !== 'stopped'
  if (wasRunning) {
    job.phase = 'stopping'
    job.message = `Spegnimento di ${server.name} (salvataggio del mondo)…`
    await manager.runBlocking(server, 'stop')
  }

  job.phase = 'switching'
  job.message = `Passaggio a ${gameLabel(job.to)}…`
  await updateServer(server.id, { installDir: target.dir }, manager)

  if (wasRunning) {
    job.phase = 'starting'
    job.message = `Avvio di ${server.name}…`
    const updated = (await loadServers()).find((s) => s.id === server.id)
    if (updated) await manager.runBlocking(updated, 'start')
  }

  job.phase = 'done'
  job.message = `${server.name} ora è un server ${gameLabel(job.to)}${target.version ? ` ${target.version}` : ''}${wasRunning ? ' ed è stato riacceso' : ''}.`
  job.finishedAt = new Date().toISOString()
}

/** Solo per i test. */
export function resetUpdateState() {
  state = null
  switches.clear()
}

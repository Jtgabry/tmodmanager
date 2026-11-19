import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { config } from './config.js'
import {
  ConsoleError,
  ensureConsoleLog,
  markSession,
  readConsole,
  rotateConsoleLog,
  validateCommand,
} from './console.js'
import {
  isAncestor,
  listProcesses,
  memoryBytes,
  type ProcessInfo,
  socketsOnPort,
  systemUptimeTicks,
  ticksToSeconds,
} from './procfs.js'
import { modsFingerprint } from './mods.js'
import { refreshInstalledModAddons } from './modAddons.js'
import { pluginsFingerprint, refreshActiveAddons } from './plugins.js'
import { paths } from './paths.js'
import type { ServerDefinition } from './registry.js'
import { listSessions, quitSession, type ScreenSession, sendLine, startSession } from './screen.js'
import { readConfigPassword, readServerConfig } from './serverConfig.js'
import { type Game, gameLabel, TERRARIA_ASSEMBLY, TERRARIA_BINARY, TSHOCK_BINARY, tshockDataDir, tshockPluginsDir } from './games.js'
import { gameVersion, installedVersion, isInstalled, recordWorldRelease } from './tml.js'

export type ServerState = 'stopped' | 'starting' | 'running' | 'stopping'
type Operation = 'start' | 'stop' | 'restart'

export class ConflictError extends Error {}

export type ServerStatus = {
  id: string
  name: string
  state: ServerState
  /** Operazione in corso avviata dall'agent, se c'è. */
  operation: Operation | null
  /** Il processo gira dentro la sessione screen gestita (quindi console e stop sono possibili). */
  managed: boolean
  pid: number | null
  subworlds: number
  uptimeSeconds: number | null
  cpuPercent: number | null
  memoryBytes: number | null
  players: { online: number; max: number }
  world: string | null
  port: number
  hasPassword: boolean
  game: Game
  /** Versione installata del gioco (Terraria, TShock o tModLoader). */
  version: string | null
  /** Versione di Terraria (per TShock e tModLoader: quella su cui si basano). */
  gameVersion: string | null
  /** Solo per i server tModLoader (compatibilità: = version). */
  tmlVersion: string | null
  /** Mod cambiate (caricate, abilitate, rimosse…) dopo l'avvio: serve un riavvio per applicarle. */
  restartRequired: boolean
  screenSession: string
  lastError: { operation: Operation; message: string; at: string } | null
}

/**
 * Processi del server. tModLoader: si riconosce dal -tmlsavedirectory, i subworld hanno -subworld.
 * Vanilla e TShock: dall'eseguibile e dal -config (unico per server).
 */
export const isServerProcess = (p: ProcessInfo, server: ServerDefinition) => {
  // Solo l'eseguibile (o "mono TerrariaServer.exe"): anche la riga di comando di screen contiene il binario e il -config
  const launched = (...binaries: string[]) =>
    p.args.slice(0, 2).some((a) => binaries.some((b) => a.endsWith(b))) && !p.args[0]?.toLowerCase().endsWith('screen') && p.args.includes(server.configPath)
  if (server.game === 'terraria') return launched(TERRARIA_BINARY, TERRARIA_ASSEMBLY)
  if (server.game === 'tshock') return launched(TSHOCK_BINARY)
  return p.args.some((a) => a.endsWith('tModLoader.dll')) && p.args.includes('-server') && p.args.includes(server.saveDir)
}

/**
 * Comando di avvio del server e variabili d'ambiente in più, nella cartella dell'installazione.
 * TShock: porta e giocatori vanno passati da riga di comando, altrimenti varrebbero quelli del suo
 * config.json; config, database, log e plugin stanno nel save/ del server (restano cambiando gioco).
 */
export function launchCommand(server: ServerDefinition, settings: { port: number; maxPlayers: number }): { command: string[]; env: Record<string, string> } {
  const args = server.launchArgs.filter((a) => a !== '-nosteam')
  if (server.game === 'terraria') {
    return { command: [`./${TERRARIA_BINARY}`, ...args, '-config', server.configPath, '-noupnp'], env: {} }
  }
  if (server.game === 'tshock') {
    const data = tshockDataDir(server.saveDir)
    return {
      command: [
        `./${TSHOCK_BINARY}`,
        ...args,
        '-config', server.configPath,
        '-port', String(settings.port),
        '-maxplayers', String(settings.maxPlayers),
        '-configpath', data,
        '-logpath', join(data, 'logs'),
        '-additionalplugins', tshockPluginsDir(server.saveDir),
        '-noupnp',
      ],
      env: { DOTNET_ROOT: join(server.installDir, 'dotnet') },
    }
  }
  return {
    command: ['bash', './start-tModLoaderServer.sh', ...server.launchArgs, '-tmlsavedirectory', server.saveDir, '-config', server.configPath],
    env: {},
  }
}

/** Domande del server vanilla a cui si risponde da soli durante l'avvio (riga incompleta in fondo alla console). */
const STARTUP_PROMPTS: [RegExp, (server: ServerDefinition) => Promise<string>][] = [
  [/Server password \(press enter for none\):\s*$/, (server) => readConfigPassword(server.configPath)],
  [/forward port\? \(y\/n\):\s*$/, async () => 'n'],
]

export class ServerManager {
  private operations = new Map<string, Operation>()
  /** Fase dell'operazione in corso (un riavvio passa da stopping a starting). */
  private phases = new Map<string, 'starting' | 'stopping'>()
  private errors = new Map<string, ServerStatus['lastError']>()
  /** Ultimo campione CPU per pid, per calcolare la percentuale tra due letture. */
  private cpuSamples = new Map<number, { ticks: number; uptime: number }>()
  /** Installazioni bloccate (aggiornamento di tModLoader in corso): niente avvii/spegnimenti dal pannello. */
  private blockedInstalls = new Map<string, string>()
  /** Server bloccati (passaggio a un altro gioco in corso): niente avvii/spegnimenti dal pannello. */
  private blockedServers = new Map<string, string>()
  /** L'agent si sta spegnendo: nessuna nuova operazione. */
  private closing = false

  blockInstall(installDir: string, reason: string) {
    this.blockedInstalls.set(installDir, reason)
  }

  unblockInstall(installDir: string) {
    this.blockedInstalls.delete(installDir)
  }

  blockServer(id: string, reason: string) {
    this.blockedServers.set(id, reason)
  }

  unblockServer(id: string) {
    this.blockedServers.delete(id)
  }

  async statusAll(servers: ServerDefinition[]): Promise<ServerStatus[]> {
    const [procs, sessions] = await Promise.all([listProcesses(), listSessions()])
    const alive = new Set(procs.map((p) => p.pid))
    for (const pid of this.cpuSamples.keys()) if (!alive.has(pid)) this.cpuSamples.delete(pid)
    return Promise.all(servers.map((s) => this.computeStatus(s, procs, sessions)))
  }

  async status(server: ServerDefinition): Promise<ServerStatus> {
    return (await this.statusAll([server]))[0]
  }

  private locate(server: ServerDefinition, procs: ProcessInfo[], sessions: ScreenSession[]) {
    const session = sessions.find((s) => s.name === server.screenSession) ?? null
    const ours = procs.filter((p) => isServerProcess(p, server))
    const main = ours.find((p) => !p.args.includes('-subworld')) ?? null
    const subworlds = ours.filter((p) => p.args.includes('-subworld'))
    const managed = Boolean(main && session && isAncestor(procs, session.pid, main.pid))
    return { session, main, subworlds, managed }
  }

  private async computeStatus(
    server: ServerDefinition,
    procs: ProcessInfo[],
    sessions: ScreenSession[],
  ): Promise<ServerStatus> {
    const { main, subworlds, managed } = this.locate(server, procs, sessions)
    const settings = await readServerConfig(server.configPath)
    const operation = this.operations.get(server.id) ?? null

    let state: ServerState = 'stopped'
    let players = 0
    let uptimeSeconds: number | null = null
    let cpuPercent: number | null = null
    let memory: number | null = null

    if (main) {
      const sockets = await socketsOnPort(settings.port)
      state = sockets.listening ? 'running' : 'starting'
      players = sockets.established

      const all = [main, ...subworlds]
      const uptime = await systemUptimeTicks()
      uptimeSeconds = Math.round(ticksToSeconds(uptime - main.startTicks))
      memory = (await Promise.all(all.map((p) => memoryBytes(p.pid)))).reduce((a, b) => a + b, 0)
      cpuPercent = this.cpuPercent(all, uptime)
    }
    const phase = this.phases.get(server.id)
    if (phase === 'stopping') state = 'stopping'
    if (phase === 'starting' && state === 'stopped') state = 'starting'
    const version = await installedVersion(server.installDir)
    const terrariaVersion = await gameVersion(server.installDir, server.game).catch(() => null)

    return {
      id: server.id,
      name: server.name,
      state,
      operation,
      managed,
      pid: main?.pid ?? null,
      subworlds: subworlds.length,
      uptimeSeconds,
      cpuPercent,
      memoryBytes: memory,
      players: { online: players, max: settings.maxPlayers },
      world: settings.worldName,
      port: settings.port,
      hasPassword: settings.hasPassword,
      game: server.game,
      version,
      gameVersion: terrariaVersion,
      tmlVersion: server.game === 'tmodloader' ? version : null,
      restartRequired: server.game !== 'terraria' && state === 'running' && main ? await this.modsChangedSinceStart(server, main.pid) : false,
      screenSession: server.screenSession,
      lastError: this.errors.get(server.id) ?? null,
    }
  }

  /**
   * La prima volta che si vede il server acceso (per quel pid) si salva l'impronta delle mod (dei plugin per TShock);
   * le volte successive si confronta. Su file, così regge anche ai riavvii dell'agent.
   */
  private async modsChangedSinceStart(server: ServerDefinition, pid: number): Promise<boolean> {
    const file = paths.modsState(server.id)
    const current = server.game === 'tshock' ? await pluginsFingerprint(server) : await modsFingerprint(server)
    let saved: { pid: number; fingerprint: string } | null = null
    try {
      saved = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      // nessuna impronta salvata
    }
    if (saved?.pid === pid) return saved.fingerprint !== current
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ pid, fingerprint: current }))
    return false
  }

  /** CPU % (100 = un core) dall'ultima lettura; alla prima lettura, media dall'avvio del processo. */
  private cpuPercent(procs: ProcessInfo[], uptime: number): number {
    let used = 0
    let elapsed = 0
    for (const p of procs) {
      const prev = this.cpuSamples.get(p.pid)
      const base = prev ?? { ticks: 0, uptime: p.startTicks }
      used += p.cpuTicks - base.ticks
      elapsed = Math.max(elapsed, uptime - base.uptime)
      this.cpuSamples.set(p.pid, { ticks: p.cpuTicks, uptime })
    }
    return elapsed > 0 ? Math.round((used / elapsed) * 1000) / 10 : 0
  }

  // --- Operazioni -------------------------------------------------------------

  start(server: ServerDefinition) {
    return this.launch(server, 'start', () => this.doStart(server))
  }

  stop(server: ServerDefinition) {
    return this.launch(server, 'stop', () => this.doStop(server))
  }

  restart(server: ServerDefinition) {
    return this.launch(server, 'restart', async () => {
      await this.doStop(server)
      await this.doStart(server)
    })
  }

  /** Valida subito (errori → eccezione), poi esegue il resto in background: lo stato si segue con GET. */
  private async launch(server: ServerDefinition, op: Operation, task: () => Promise<void>) {
    if (this.closing) throw new ConflictError('L\'agent si sta spegnendo: riprova tra poco')
    const running = this.operations.get(server.id)
    if (running) throw new ConflictError(`Operazione "${running}" già in corso`)
    const blocked = this.blockedServers.get(server.id) ?? this.blockedInstalls.get(server.installDir)
    if (blocked) throw new ConflictError(blocked)
    if (op === 'start' && !(await isInstalled(server.installDir))) {
      throw new ConflictError(`${gameLabel(server.game)} non è installato: installalo da Gestione server → Installazioni`)
    }

    const { main, managed } = this.locate(server, await listProcesses(), await listSessions())
    if (op === 'start' && main) throw new ConflictError('Il server è già acceso')
    if (op !== 'start' && !main) throw new ConflictError('Il server è spento')
    if (op !== 'start' && !managed) {
      throw new ConflictError(
        `Il server non gira nella sessione screen "${server.screenSession}": l'agent non può inviargli comandi`,
      )
    }

    this.operations.set(server.id, op)
    this.errors.delete(server.id)
    task()
      .catch((err: Error) => {
        this.errors.set(server.id, { operation: op, message: err.message, at: new Date().toISOString() })
      })
      .finally(() => {
        this.operations.delete(server.id)
        this.phases.delete(server.id)
      })
  }

  /** Avvio/spegnimento atteso fino alla fine (per l'aggiornamento di tModLoader). Ignora il blocco dell'installazione. */
  async runBlocking(server: ServerDefinition, op: 'start' | 'stop') {
    const running = this.operations.get(server.id)
    if (running) throw new ConflictError(`Operazione "${running}" già in corso su ${server.name}`)
    this.operations.set(server.id, op)
    this.errors.delete(server.id)
    try {
      if (op === 'start') await this.doStart(server)
      else await this.doStop(server)
    } catch (err) {
      this.errors.set(server.id, { operation: op, message: (err as Error).message, at: new Date().toISOString() })
      throw err
    } finally {
      this.operations.delete(server.id)
      this.phases.delete(server.id)
    }
  }

  private async doStart(server: ServerDefinition) {
    this.phases.set(server.id, 'starting')
    const sessions = await listSessions()
    const leftover = sessions.find((s) => s.name === server.screenSession)
    // Sessione rimasta aperta senza server (es. shell interattiva dopo "exit"): la chiudiamo per ripartire puliti
    if (leftover) await quitSession(leftover)

    const logFile = await rotateConsoleLog(server)
    const settings = await readServerConfig(server.configPath)
    if (server.game === 'tshock') {
      // TShock non crea da solo la cartella dei plugin aggiuntivi (e senza non parte)
      await mkdir(tshockPluginsDir(server.saveDir), { recursive: true })
      await mkdir(tshockDataDir(server.saveDir), { recursive: true })
      // Add-on di tModManager attivi (es. LiveMap): alla versione di questo pannello
      await refreshActiveAddons(server).catch(() => [])
    }
    // Add-on di tModManager installati come mod (es. LiveMap): alla versione di questo pannello
    if (server.game === 'tmodloader') await refreshInstalledModAddons(server).catch(() => [])
    const { command, env } = launchCommand(server, settings)
    await startSession(server.screenSession, server.installDir, logFile, paths.screenrc(), command, env)

    const session = (await listSessions()).find((s) => s.name === server.screenSession)
    if (session) await markSession(server, session)

    const deadline = Date.now() + config.startTimeout * 1000
    let answeredAt = -1
    while (Date.now() < deadline) {
      await sleep(1000)
      const { main, session: alive } = this.locate(server, await listProcesses(), await listSessions())
      if (server.game !== 'tmodloader' && alive) answeredAt = await this.answerPrompts(server, alive, answeredAt)
      // Al primo avvio lo script di tModLoader scarica .NET prima di lanciare il server: finché la
      // sessione screen è viva l'avvio è in corso anche se il processo del server non c'è ancora
      if (!main && !alive) throw new Error(`Il server si è chiuso durante l'avvio (vedi ${logFile})`)
      if ((await socketsOnPort(settings.port)).listening) return
    }
    throw new Error(`Il server non ha aperto la porta ${settings.port} entro ${config.startTimeout}s`)
  }

  private async doStop(server: ServerDefinition) {
    this.phases.set(server.id, 'stopping')
    const { session } = this.locate(server, await listProcesses(), await listSessions())
    if (!session) throw new Error('Sessione screen non trovata')

    // "exit" salva il mondo e chiude il server (e i subworld)
    await sendLine(session, 'exit')

    const deadline = Date.now() + config.stopTimeout * 1000
    while (Date.now() < deadline) {
      await sleep(1000)
      if (!this.locate(server, await listProcesses(), await listSessions()).main) {
        // Il mondo è appena stato salvato: si annota la sua versione per l'installazione
        await recordWorldRelease(server).catch(() => undefined)
        return
      }
    }
    throw new Error(`Il server non si è chiuso entro ${config.stopTimeout}s dopo "exit"`)
  }

  /**
   * Il server vanilla chiede password e port forwarding quando non li trova nella configurazione:
   * si risponde (la password del serverconfig, se c'è; niente UPnP).
   * Restituisce la posizione del log fino a cui si è già risposto.
   */
  private async answerPrompts(server: ServerDefinition, session: ScreenSession, answeredAt: number): Promise<number> {
    const { data, offset } = await readConsole(server)
    if (offset === answeredAt) return answeredAt
    const tail = data.slice(data.lastIndexOf('\n') + 1)
    for (const [prompt, answer] of STARTUP_PROMPTS) {
      if (prompt.test(tail)) {
        await sendLine(session, await answer(server))
        return offset
      }
    }
    return answeredAt
  }

  // --- Spegnimento dell'agent -------------------------------------------------

  /**
   * Manda "exit" a tutti i server accesi nelle loro sessioni (in parallelo) e aspetta che salvino e
   * si chiudano. Le sessioni ancora senza server (script di avvio che sta scaricando .NET) vengono
   * chiuse. Restituisce i server che erano accesi o in avvio e quelli che non si sono chiusi in tempo.
   */
  async shutdownAll(
    servers: ServerDefinition[],
    log: (message: string) => void,
    /** Chiamata con i server accesi prima di aspettarli (per annotarli subito, in caso di uccisione). */
    onTargets: (ids: string[]) => Promise<void> = async () => undefined,
  ) {
    this.closing = true
    const [procs, sessions] = await Promise.all([listProcesses(), listSessions()])
    const targets = servers
      .map((server) => ({ server, ...this.locate(server, procs, sessions) }))
      .filter((t) => t.session !== null && (!t.main || t.managed))

    const wasRunning = targets.map((t) => t.server.id)
    const timedOut: string[] = []
    await onTargets(wasRunning).catch((err: Error) => log(`Impossibile annotare i server da riaccendere: ${err.message}`))
    await Promise.all(
      targets.map(async ({ server, main, session }) => {
        this.phases.set(server.id, 'stopping')
        if (!main) {
          // Nessun mondo da salvare: c'è solo lo script di avvio
          await quitSession(session!).catch(() => undefined)
          return
        }
        log(`Spegnimento di ${server.name} (salvataggio del mondo)…`)
        await sendLine(session!, 'exit').catch(() => undefined)
        const deadline = Date.now() + config.stopTimeout * 1000
        while (Date.now() < deadline) {
          await sleep(1000)
          const now = this.locate(server, await listProcesses(), await listSessions())
          if (!now.main) {
            if (now.session) await quitSession(now.session).catch(() => undefined)
            log(`${server.name} spento`)
            return
          }
        }
        timedOut.push(server.id)
        log(`${server.name} non si è chiuso entro ${config.stopTimeout}s`)
      }),
    )
    return { wasRunning, timedOut }
  }

  // --- Console ----------------------------------------------------------------

  /** Output della console; se il server gira nella sua sessione, si assicura che il log sia attivo. */
  async console(server: ServerDefinition, offset?: number) {
    await this.ensureLog(server)
    return readConsole(server, offset)
  }

  /** Se il server gira nella sua sessione, si assicura che screen stia scrivendo il log della console. */
  async ensureLog(server: ServerDefinition) {
    const { session, main, managed } = this.locate(server, await listProcesses(), await listSessions())
    if (session && main && managed) await ensureConsoleLog(server, session)
  }

  async sendCommand(server: ServerDefinition, command: unknown) {
    const line = validateCommand(command)
    const { session, main, managed } = this.locate(server, await listProcesses(), await listSessions())
    if (!main) throw new ConflictError('Il server è spento')
    if (!session || !managed) throw new ConflictError('Il server non gira nella sessione screen gestita')
    await ensureConsoleLog(server, session)
    await sendLine(session, line)
  }
}

export { ConsoleError }

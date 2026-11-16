import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
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
import { paths } from './paths.js'
import type { ServerDefinition } from './registry.js'
import { listSessions, quitSession, type ScreenSession, sendLine, startSession } from './screen.js'
import { readServerConfig } from './serverConfig.js'
import { installedVersion } from './tml.js'

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
  tmlVersion: string | null
  /** Mod cambiate (caricate, abilitate, rimosse…) dopo l'avvio: serve un riavvio per applicarle. */
  restartRequired: boolean
  screenSession: string
  lastError: { operation: Operation; message: string; at: string } | null
}

/** Processo principale di tModLoader per quel server: si riconosce dal -tmlsavedirectory, i subworld hanno -subworld. */
const isTmlServer = (p: ProcessInfo, saveDir: string) =>
  p.args.some((a) => a.endsWith('tModLoader.dll')) && p.args.includes('-server') && p.args.includes(saveDir)

export class ServerManager {
  private operations = new Map<string, Operation>()
  /** Fase dell'operazione in corso (un riavvio passa da stopping a starting). */
  private phases = new Map<string, 'starting' | 'stopping'>()
  private errors = new Map<string, ServerStatus['lastError']>()
  /** Ultimo campione CPU per pid, per calcolare la percentuale tra due letture. */
  private cpuSamples = new Map<number, { ticks: number; uptime: number }>()
  /** Installazioni bloccate (aggiornamento di tModLoader in corso): niente avvii/spegnimenti dal pannello. */
  private blockedInstalls = new Map<string, string>()
  /** L'agent si sta spegnendo: nessuna nuova operazione. */
  private closing = false

  blockInstall(installDir: string, reason: string) {
    this.blockedInstalls.set(installDir, reason)
  }

  unblockInstall(installDir: string) {
    this.blockedInstalls.delete(installDir)
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
    const ours = procs.filter((p) => isTmlServer(p, server.saveDir))
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
      tmlVersion: await this.tmlVersion(server),
      restartRequired: state === 'running' && main ? await this.modsChangedSinceStart(server, main.pid) : false,
      screenSession: server.screenSession,
      lastError: this.errors.get(server.id) ?? null,
    }
  }

  /**
   * La prima volta che si vede il server acceso (per quel pid) si salva l'impronta delle mod;
   * le volte successive si confronta. Su file, così regge anche ai riavvii dell'agent.
   */
  private async modsChangedSinceStart(server: ServerDefinition, pid: number): Promise<boolean> {
    const file = paths.modsState(server.id)
    const current = await modsFingerprint(server)
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

  private tmlVersion(server: ServerDefinition) {
    return installedVersion(server.installDir)
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
    const blocked = this.blockedInstalls.get(server.installDir)
    if (blocked) throw new ConflictError(blocked)

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
    await startSession(server.screenSession, server.installDir, logFile, paths.screenrc(), [
      'bash',
      './start-tModLoaderServer.sh',
      ...server.launchArgs,
      '-tmlsavedirectory',
      server.saveDir,
      '-config',
      server.configPath,
    ])

    const session = (await listSessions()).find((s) => s.name === server.screenSession)
    if (session) await markSession(server, session)

    const settings = await readServerConfig(server.configPath)
    const deadline = Date.now() + config.startTimeout * 1000
    while (Date.now() < deadline) {
      await sleep(1000)
      const { main, session: alive } = this.locate(server, await listProcesses(), await listSessions())
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
      if (!this.locate(server, await listProcesses(), await listSessions()).main) return
    }
    throw new Error(`Il server non si è chiuso entro ${config.stopTimeout}s dopo "exit"`)
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

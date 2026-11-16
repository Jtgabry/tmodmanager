import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { config } from './config.js'
import { ConflictError, type ServerManager } from './manager.js'
import { paths } from './paths.js'
import { findServer, loadServers } from './registry.js'

/**
 * Spegnimento e riavvio dell'agent con i server dentro (Docker, AGENT_STOP_SERVERS_ON_EXIT=1):
 *  - SIGTERM/SIGINT → "exit" a tutti i server (salvano il mondo), si annota chi era acceso, poi si esce
 *  - all'avvio successivo si riaccendono i server annotati
 * Un secondo segnale durante lo spegnimento fa uscire subito.
 */

type Log = { info: (message: string) => void; warn: (message: string) => void }

async function writeResume(ids: string[]) {
  const file = paths.resumeServers()
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, `${JSON.stringify({ servers: ids, at: new Date().toISOString() })}\n`)
  await rename(tmp, file)
}

/** Riaccende i server spenti dall'ultimo spegnimento dell'agent (una volta: il file viene tolto). */
export async function resumeServers(manager: ServerManager, log: Log) {
  let ids: string[]
  try {
    const parsed = JSON.parse(await readFile(paths.resumeServers(), 'utf8')) as { servers?: unknown }
    ids = Array.isArray(parsed.servers) ? parsed.servers.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return
  }
  await rm(paths.resumeServers(), { force: true })
  for (const id of ids) {
    const server = await findServer(id)
    if (!server) continue
    try {
      await manager.start(server)
      log.info(`Riavvio di ${server.name} (era acceso prima dello spegnimento dell'agent)`)
    } catch (err) {
      // Già acceso (es. sopravvissuto all'agent) o installazione bloccata: niente da fare
      if (!(err instanceof ConflictError)) log.warn(`Riavvio di ${server.name} non riuscito: ${(err as Error).message}`)
    }
  }
}

export function handleShutdown(manager: ServerManager, close: () => Promise<void>, log: Log) {
  let stopping = false
  const shutdown = async (signal: NodeJS.Signals) => {
    if (stopping) {
      log.warn(`${signal} ricevuto di nuovo: uscita immediata`)
      process.exit(1)
    }
    stopping = true
    log.info(`${signal} ricevuto: spegnimento dell'agent`)
    if (config.stopServersOnExit) {
      const servers = await loadServers().catch(() => [])
      const { wasRunning, timedOut } = await manager.shutdownAll(servers, log.info, async (ids) => {
        if (ids.length) await writeResume(ids)
      })
      if (wasRunning.length) log.info(`Server spenti: ${wasRunning.length - timedOut.length}/${wasRunning.length}`)
    }
    // Le connessioni aperte (console WebSocket) non devono trattenere l'uscita
    await Promise.race([close().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 3000))])
    process.exit(0)
  }
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, (s) => void shutdown(s))
}

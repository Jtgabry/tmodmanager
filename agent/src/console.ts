import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { paths } from './paths.js'
import type { ServerDefinition } from './registry.js'
import { enableLogging, hardcopy, type ScreenSession } from './screen.js'

/** Quanto log restituire alla prima apertura della console. */
const INITIAL_TAIL_BYTES = 64 * 1024
/** Massimo restituito per singola lettura (il client poi richiede il resto). */
const MAX_CHUNK_BYTES = 256 * 1024

const logsDir = (server: ServerDefinition) => paths.serverLogs(server.id)
export const consoleLogPath = (server: ServerDefinition) => join(logsDir(server), 'console.log')
/** Annota a quale sessione screen (pid) appartiene il log corrente. */
const markerPath = (server: ServerDefinition) => join(logsDir(server), 'console.session')

export class ConsoleError extends Error {}

/** Il log della sessione precedente diventa console.log.1. */
export async function rotateConsoleLog(server: ServerDefinition): Promise<string> {
  await mkdir(logsDir(server), { recursive: true })
  const logFile = consoleLogPath(server)
  try {
    if ((await stat(logFile)).size > 0) await rename(logFile, `${logFile}.1`)
  } catch {
    // nessun log precedente
  }
  return logFile
}

export async function markSession(server: ServerDefinition, session: ScreenSession) {
  await writeFile(markerPath(server), String(session.pid))
}

/**
 * Garantisce che la sessione scriva sul log della console. Serve per le sessioni non avviate
 * dall'agent (es. avviate a mano senza -L): si parte dallo scrollback attuale e si attiva il log.
 */
export async function ensureConsoleLog(server: ServerDefinition, session: ScreenSession) {
  const marker = await readFile(markerPath(server), 'utf8').catch(() => '')
  if (marker.trim() === String(session.pid)) return

  const logFile = await rotateConsoleLog(server)
  const snapshot = `${logFile}.snapshot`
  try {
    await hardcopy(session, snapshot)
    // hardcopy riempie le righe vuote dello schermo: togliamo quelle in fondo
    const history = (await readFile(snapshot, 'utf8')).replace(/\s+$/, '')
    await writeFile(logFile, history ? `${history}\n` : '')
  } catch {
    await writeFile(logFile, '')
  } finally {
    await rm(snapshot, { force: true })
  }
  await enableLogging(session, logFile)
  await markSession(server, session)
}

export type ConsoleChunk = {
  /** Posizione (byte) da passare alla prossima lettura. */
  offset: number
  data: string
  /** Il log è ripartito da capo (nuova sessione): il client deve svuotare l'output. */
  reset: boolean
}

/**
 * Legge il log a partire da `offset`. Senza offset restituisce la coda; se il file è più corto
 * dell'offset (log ruotato da un riavvio) riparte e segnala reset.
 */
export async function readConsole(server: ServerDefinition, offset?: number): Promise<ConsoleChunk> {
  let size: number
  try {
    size = (await stat(consoleLogPath(server))).size
  } catch {
    return { offset: 0, data: '', reset: offset !== undefined && offset > 0 }
  }

  let start = offset ?? Math.max(0, size - INITIAL_TAIL_BYTES)
  let reset = offset === undefined
  if (start > size) {
    start = Math.max(0, size - INITIAL_TAIL_BYTES)
    reset = true
  }
  const end = Math.min(size, start + MAX_CHUNK_BYTES)
  if (end <= start) return { offset: start, data: '', reset }

  const file = await open(consoleLogPath(server))
  try {
    const { buffer, bytesRead } = await file.read({ buffer: Buffer.alloc(end - start), position: start })
    // Non tagliare un carattere UTF-8 a metà: ci si ferma all'ultimo byte iniziale completo
    let usable = bytesRead
    while (usable > 0 && end < size && (buffer[usable - 1] & 0xc0) === 0x80) usable--
    if (usable > 0 && end < size && buffer[usable - 1] >= 0xc0) usable--
    // Alla prima lettura dalla coda si salta la riga probabilmente tagliata
    let skip = 0
    if (reset && start > 0) skip = Math.max(0, buffer.subarray(0, usable).indexOf(0x0a) + 1)
    return { offset: start + usable, data: buffer.toString('utf8', skip, usable), reset }
  } finally {
    await file.close()
  }
}

/** Una riga di comando valida: niente caratteri di controllo, lunghezza ragionevole. */
export function validateCommand(command: unknown): string {
  if (typeof command !== 'string') throw new ConsoleError('Comando mancante')
  const trimmed = command.trim()
  if (!trimmed) throw new ConsoleError('Comando vuoto')
  if (trimmed.length > 500) throw new ConsoleError('Comando troppo lungo (max 500 caratteri)')
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new ConsoleError('Il comando contiene caratteri non ammessi')
  return trimmed
}

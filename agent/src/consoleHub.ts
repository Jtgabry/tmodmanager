import { createHmac, timingSafeEqual } from 'node:crypto'
import type { WebSocket } from 'ws'
import { config } from './config.js'
import { readConsole } from './console.js'
import type { ServerManager } from './manager.js'
import { findServer, type ServerDefinition } from './registry.js'

/**
 * Console in tempo reale via WebSocket.
 *
 * Il browser non ha il token dell'agent: chiede a Laravel un "ticket" (che Laravel firma con lo
 * stesso token, dopo aver controllato i permessi) e apre wss://…/ws/servers/<id>/console?ticket=…
 * Apache inoltra /ws/ all'agent. Il ticket vale per un solo server e scade dopo pochi secondi
 * (serve solo ad aprire la connessione); la connessione stessa dura al massimo MAX_SESSION_MS,
 * poi il browser ne apre un'altra con un ticket nuovo (così un permesso revocato smette di valere).
 */

const POLL_MS = 250
const ENSURE_LOG_MS = 3000
const MAX_SESSION_MS = 30 * 60 * 1000

const b64url = (buf: Buffer) => buf.toString('base64url')

export function signTicket(payload: { s: string; u: number; e: number }, token = config.token) {
  const body = b64url(Buffer.from(JSON.stringify(payload)))
  const sig = b64url(createHmac('sha256', token).update(`ws-ticket.${body}`).digest())
  return `${body}.${sig}`
}

/** Verifica firma, scadenza e server del ticket. */
export function verifyTicket(ticket: unknown, serverId: string, now = Date.now(), token = config.token): { userId: number } | null {
  if (typeof ticket !== 'string' || ticket.length > 1024) return null
  const [body, sig, extra] = ticket.split('.')
  if (!body || !sig || extra !== undefined) return null
  const expected = createHmac('sha256', token).update(`ws-ticket.${body}`).digest()
  const given = Buffer.from(sig, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { s?: unknown; u?: unknown; e?: unknown }
    if (payload.s !== serverId || typeof payload.e !== 'number' || typeof payload.u !== 'number') return null
    if (payload.e * 1000 < now) return null
    return { userId: payload.u }
  } catch {
    return null
  }
}

type Client = { socket: WebSocket; offset: number; openedAt: number }
type Channel = { server: ServerDefinition; clients: Set<Client>; timer: NodeJS.Timeout; lastEnsure: number; busy: boolean }

export class ConsoleHub {
  private channels = new Map<string, Channel>()

  constructor(private readonly manager: ServerManager) {}

  async attach(serverId: string, socket: WebSocket) {
    const server = await findServer(serverId)
    if (!server) {
      socket.close(4004, 'server non trovato')
      return
    }
    // Prima risposta: la coda del log (come la GET /console senza offset); assicura anche che il log sia attivo
    const first = await this.manager.console(server)
    const client: Client = { socket, offset: first.offset, openedAt: Date.now() }
    send(socket, { type: 'chunk', data: first.data, offset: first.offset, reset: true })

    let channel = this.channels.get(serverId)
    if (!channel) {
      channel = { server, clients: new Set(), timer: setInterval(() => void this.tick(serverId), POLL_MS), lastEnsure: Date.now(), busy: false }
      this.channels.set(serverId, channel)
    }
    channel.clients.add(client)

    const detach = () => {
      const ch = this.channels.get(serverId)
      if (!ch) return
      ch.clients.delete(client)
      if (ch.clients.size === 0) {
        clearInterval(ch.timer)
        this.channels.delete(serverId)
      }
    }
    // Ping periodico: tiene viva la connessione attraverso Apache anche quando la console è ferma
    const ping = setInterval(() => socket.readyState === socket.OPEN && socket.ping(), 25_000)
    const close = () => {
      clearInterval(ping)
      detach()
    }
    socket.on('close', close)
    socket.on('error', close)
    // Il client non manda niente (i comandi passano da Laravel, che li registra): messaggi ignorati
    socket.on('message', () => undefined)
  }

  private async tick(serverId: string) {
    const channel = this.channels.get(serverId)
    if (!channel || channel.busy) return
    channel.busy = true
    try {
      if (Date.now() - channel.lastEnsure > ENSURE_LOG_MS) {
        channel.lastEnsure = Date.now()
        // Server riavviato → nuova sessione screen: manager.console riattiva il log se serve
        await this.manager.ensureLog(channel.server).catch(() => undefined)
      }
      for (const client of channel.clients) {
        if (Date.now() - client.openedAt > MAX_SESSION_MS) {
          client.socket.close(4001, 'sessione scaduta')
          continue
        }
        const chunk = await readConsole(channel.server, client.offset)
        if (chunk.data || chunk.reset || chunk.offset !== client.offset) {
          client.offset = chunk.offset
          send(client.socket, { type: 'chunk', data: chunk.data, offset: chunk.offset, reset: chunk.reset })
        }
      }
    } catch {
      // errore di lettura transitorio: si riprova al prossimo giro
    } finally {
      channel.busy = false
    }
  }
}

function send(socket: WebSocket, message: unknown) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
}

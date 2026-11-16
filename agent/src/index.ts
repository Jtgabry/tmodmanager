import { timingSafeEqual } from 'node:crypto'
import websocket from '@fastify/websocket'
import Fastify from 'fastify'
import { config } from './config.js'
import { ConsoleHub, verifyTicket } from './consoleHub.js'
import { ServerManager } from './manager.js'
import { handleShutdown, resumeServers } from './lifecycle.js'
import { migrateLegacyData } from './migrate.js'
import { registryPath } from './registry.js'
import { adminRoutes } from './routes/admin.js'
import { fileRoutes } from './routes/files.js'
import { modRoutes } from './routes/mods.js'
import { serverRoutes } from './routes/servers.js'
import { trashRoutes } from './routes/trash.js'
import { workshopRoutes } from './routes/workshop.js'
import { purgeExpiredTrash } from './trash.js'

// Agent di tModManager: gira come l'utente proprietario dei server e fa tutto ciò che Laravel
// non può fare da www-data (sessioni screen, processi, file dei server).
// Ascolta SOLO su localhost e accetta solo richieste con il token condiviso.

if (config.token.length < 32) {
  console.error('AGENT_TOKEN mancante o troppo corto (min 32 caratteri).')
  process.exit(1)
}

const expected = Buffer.from(`Bearer ${config.token}`)
const app = Fastify({ logger: true })
const manager = new ServerManager()

// Dati della vecchia cartella agent/data → cartella dati unica (una volta sola)
await migrateLegacyData((message) => app.log.info(message))

const WS_CONSOLE = /^\/ws\/servers\/([a-z0-9][a-z0-9-]{0,31})\/console(\?|$)/

app.addHook('onRequest', async (req, reply) => {
  // Console WebSocket (arriva dal browser tramite Apache): autenticata dal ticket firmato da Laravel
  const ws = req.url.match(WS_CONSOLE)
  if (ws) {
    const ticket = new URL(req.url, 'http://agent').searchParams.get('ticket')
    if (!verifyTicket(ticket, ws[1])) return reply.code(401).send({ error: 'unauthorized' })
    return
  }
  // Tutto il resto è solo per Laravel (in locale): una richiesta passata da un proxy non è mai valida
  if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host']) return reply.code(403).send({ error: 'forbidden' })
  const given = Buffer.from(req.headers.authorization ?? '')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return reply.code(401).send({ error: 'unauthorized' })
  }
})

app.setErrorHandler((err, _req, reply) => {
  app.log.error(err)
  const statusCode = (err as { statusCode?: number }).statusCode ?? 500
  reply.code(statusCode).send({ error: 'agent_error', message: (err as Error).message })
})

app.get('/health', async () => ({
  status: 'ok',
  user: process.env.USER ?? null,
  uid: process.getuid?.() ?? null,
  dataDir: config.dataDir,
  registry: registryPath(),
}))

// Rete di sicurezza: un errore non gestito va nel log, non deve far cadere l'agent (e con lui il pannello)
process.on('unhandledRejection', (reason) => app.log.error({ err: reason }, 'Promise rifiutata non gestita'))

await app.register(websocket, { options: { maxPayload: 4096 } })
const hub = new ConsoleHub(manager)
app.get<{ Params: { id: string } }>('/ws/servers/:id/console', { websocket: true }, (socket, req) => {
  hub.attach(req.params.id, socket).catch((err) => {
    app.log.error(err)
    socket.close(1011, 'errore interno')
  })
})

await app.register(serverRoutes, { manager })
await app.register(modRoutes)
await app.register(fileRoutes)
await app.register(trashRoutes)
await app.register(workshopRoutes)
await app.register(adminRoutes, { manager })

// Cestino: gli elementi più vecchi di config.trashRetentionDays si cancellano all'avvio e poi ogni ora
const purge = () =>
  purgeExpiredTrash()
    .then((n) => n && app.log.info(`Cestino: ${n} elementi scaduti cancellati`))
    .catch((err) => app.log.error(err))
void purge()
setInterval(purge, 60 * 60 * 1000).unref()

handleShutdown(manager, () => app.close(), { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) })

app
  .listen({ host: config.host, port: config.port })
  .then(() => {
    resumeServers(manager, { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) }).catch((err) => app.log.error(err))
  })
  .catch((err) => {
    app.log.error(err)
    process.exit(1)
  })

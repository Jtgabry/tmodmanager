import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import type { ServerManager } from '../manager.js'
import {
  CreateServerInput,
  createServer,
  knownInstallations,
  recreateWorld,
  removeServer,
  ServerAdminError,
  serverSettings,
  suggestPort,
  UpdateServerInput,
  updateServer,
} from '../serverAdmin.js'
import { GAMES } from '../games.js'
import { findInstallation, listInstallations, listReleases, startJob, TmlError } from '../tml.js'

/** Operazioni da amministratore: server (creazione, impostazioni, rimozione) e installazioni di Terraria e tModLoader. */
export async function adminRoutes(app: FastifyInstance, { manager }: { manager: ServerManager }) {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ServerAdminError) {
      const error = err.status === 409 ? 'conflict' : err.status === 404 ? 'not_found' : 'invalid'
      return reply.code(err.status).send({ error, message: err.message, details: err.field ? { field: err.field } : {} })
    }
    if (err instanceof TmlError) {
      const error = err.status === 409 ? 'conflict' : err.status === 404 ? 'not_found' : err.status === 502 ? 'upstream' : 'invalid'
      return reply.code(err.status).send({ error, message: err.message })
    }
    if (err instanceof z.ZodError) {
      const first = err.issues[0]
      return reply.code(422).send({
        error: 'invalid',
        message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        details: { field: first?.path.join('.') ?? null },
      })
    }
    throw err
  })

  // --- Server ---------------------------------------------------------------------------------

  app.get('/admin/servers/defaults', async () => ({
    data: { port: await suggestPort(), installations: await knownInstallations(), ports: config.gamePorts },
  }))

  app.post('/admin/servers', async (req, reply) => {
    const input = CreateServerInput.parse(req.body)
    return reply.code(201).send({ data: await createServer(input) })
  })

  app.get<{ Params: { id: string } }>('/admin/servers/:id', async (req) => ({ data: await serverSettings(req.params.id) }))

  app.patch<{ Params: { id: string } }>('/admin/servers/:id', async (req) => {
    const input = UpdateServerInput.parse(req.body)
    return { data: await updateServer(req.params.id, input, manager) }
  })

  app.post<{ Params: { id: string } }>('/admin/servers/:id/world/recreate', async (req) => ({ data: await recreateWorld(req.params.id, manager) }))

  app.delete<{ Params: { id: string } }>('/admin/servers/:id', async (req) => ({ data: await removeServer(req.params.id, manager) }))

  // --- Installazioni (Terraria e tModLoader) ---------------------------------------------------

  app.get('/admin/installations', async () => ({ data: await listInstallations() }))

  app.get<{ Params: { game: string }; Querystring: { refresh?: string } }>('/admin/releases/:game', async (req, reply) => {
    const game = z.enum(GAMES).safeParse(req.params.game)
    if (!game.success) return reply.code(404).send({ error: 'not_found', message: 'Gioco sconosciuto' })
    return { data: await listReleases(game.data, req.query.refresh === '1') }
  })

  const JobInput = z.union([
    z.object({ version: z.string().regex(/^[\d.]{3,32}$/), restartServers: z.boolean().default(true) }),
    z.object({ backup: z.string().min(1), restartServers: z.boolean().default(true) }),
  ])

  app.post<{ Params: { id: string } }>('/admin/installations/:id/update', async (req, reply) => {
    const input = JobInput.parse(req.body)
    const installation = await findInstallation(req.params.id)
    const target = 'version' in input ? { version: input.version } : { backup: input.backup }
    return reply.code(202).send({ data: await startJob(installation, target, input.restartServers, manager) })
  })
}

import type { FastifyInstance, FastifyReply } from 'fastify'
import { ConflictError, ConsoleError, type ServerManager } from '../manager.js'
import { findServer, loadServers, type ServerDefinition } from '../registry.js'
import { tr } from '../i18n.js'

type IdParams = { Params: { id: string } }

export async function serverRoutes(app: FastifyInstance, { manager }: { manager: ServerManager }) {
  const withServer = async (id: string, reply: FastifyReply): Promise<ServerDefinition | null> => {
    const server = await findServer(id)
    if (!server) reply.code(404).send({ error: 'not_found', message: tr('Server "{id}" not found', { id }) })
    return server ?? null
  }

  app.get('/servers', async () => ({ data: await manager.statusAll(await loadServers()) }))

  app.get<IdParams>('/servers/:id', async (req, reply) => {
    const server = await withServer(req.params.id, reply)
    if (server) return { data: await manager.status(server) }
  })

  for (const op of ['start', 'stop', 'restart'] as const) {
    app.post<IdParams>(`/servers/:id/${op}`, async (req, reply) => {
      const server = await withServer(req.params.id, reply)
      if (!server) return
      try {
        await manager[op](server)
      } catch (err) {
        if (err instanceof ConflictError) return reply.code(409).send({ error: 'conflict', message: err.message })
        throw err
      }
      // 202: l'operazione prosegue in background, lo stato si segue con GET /servers/:id
      return reply.code(202).send({ data: await manager.status(server) })
    })
  }

  app.get<IdParams & { Querystring: { offset?: string } }>('/servers/:id/console', async (req, reply) => {
    const server = await withServer(req.params.id, reply)
    if (!server) return
    const raw = req.query.offset
    const offset = raw === undefined || raw === '' ? undefined : Number(raw)
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) {
      return reply.code(422).send({ error: 'invalid', message: tr('invalid offset') })
    }
    return { data: await manager.console(server, offset) }
  })

  app.post<IdParams & { Body: { command?: unknown } }>('/servers/:id/console', async (req, reply) => {
    const server = await withServer(req.params.id, reply)
    if (!server) return
    try {
      await manager.sendCommand(server, req.body?.command)
    } catch (err) {
      if (err instanceof ConsoleError) return reply.code(422).send({ error: 'invalid', message: err.message })
      if (err instanceof ConflictError) return reply.code(409).send({ error: 'conflict', message: err.message })
      throw err
    }
    return reply.code(204).send()
  })
}

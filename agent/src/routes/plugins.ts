import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Readable } from 'node:stream'
import { ModError, withServerLock } from '../mods.js'
import {
  deleteOldPluginVersions,
  deletePlugin,
  deletePluginVersion,
  listPlugins,
  pluginVersionPath,
  setPluginEnabled,
  uploadPlugin,
  usePluginVersion,
} from '../plugins.js'
import { findServer, type ServerDefinition } from '../registry.js'

type Params = { Params: { id: string; name?: string; version?: string } }

const truthy = (v: unknown) => v === true || v === 'true' || v === '1'

/** Plugin dei server TShock: elenco, caricamento, versioni, attivazione, eliminazione. */
export async function pluginRoutes(app: FastifyInstance) {
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload))

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ModError) {
      const error = err.status === 409 ? 'conflict' : err.status === 404 ? 'not_found' : 'invalid'
      return reply.code(err.status).send({ error, message: err.message })
    }
    throw err
  })

  // Solo per TShock: sugli altri server i plugin restano su disco e tornano passando a TShock
  const server = async (id: string, reply: FastifyReply): Promise<ServerDefinition | null> => {
    const found = await findServer(id)
    if (!found) {
      reply.code(404).send({ error: 'not_found', message: `Server "${id}" non trovato` })
      return null
    }
    if (found.game !== 'tshock') {
      reply.code(409).send({ error: 'conflict', message: `${found.name} non è un server TShock: i plugin esistono solo con TShock` })
      return null
    }
    return found
  }

  app.get<Params>('/servers/:id/plugins', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (s) return { data: await withServerLock(s, () => listPlugins(s)) }
  })

  app.put<Params & { Querystring: { filename?: string; enable?: string } }>('/servers/:id/plugins', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    if (req.headers['content-type'] !== 'application/octet-stream') throw new ModError('Invia la .dll come application/octet-stream', 422)
    const result = await uploadPlugin(s, req.query.filename, req.body as Readable, truthy(req.query.enable), (task) => withServerLock(s, task))
    return reply.code(result.duplicate ? 200 : 201).send({ data: result })
  })

  app.patch<Params & { Body: { enabled?: unknown } }>('/servers/:id/plugins/:name', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const enabled = req.body?.enabled
    if (typeof enabled !== 'boolean') throw new ModError('Campo "enabled" mancante', 422)
    return { data: await withServerLock(s, () => setPluginEnabled(s, req.params.name, enabled)) }
  })

  app.delete<Params>('/servers/:id/plugins/:name', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    await withServerLock(s, () => deletePlugin(s, req.params.name))
    return reply.code(204).send()
  })

  app.post<Params>('/servers/:id/plugins/:name/versions/:version/use', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (s) return { data: await withServerLock(s, () => usePluginVersion(s, req.params.name, req.params.version)) }
  })

  app.delete<Params>('/servers/:id/plugins/:name/versions/:version', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (s) return { data: await withServerLock(s, () => deletePluginVersion(s, req.params.name, req.params.version)) }
  })

  // Tutte le versioni tranne quella scelta
  app.delete<Params>('/servers/:id/plugins/:name/versions', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (s) return { data: await withServerLock(s, () => deleteOldPluginVersions(s, req.params.name)) }
  })

  app.get<Params>('/servers/:id/plugins/:name/versions/:version/download', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const { path, filename } = await pluginVersionPath(s, req.params.name, req.params.version)
    const { size } = await stat(path)
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', size)
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(createReadStream(path))
  })
}

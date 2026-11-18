import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { findServer, type ServerDefinition } from '../registry.js'
import { mapChunkPath, mapOverviewPath, worldMap } from '../worldMap.js'

type Params = { Params: { id: string; source?: string; cx?: string; cy?: string }; Querystring: { watching?: string } }

/** Mappa del mondo (sezione "Mondo"): stato, riquadri e panoramica. */
export async function mapRoutes(app: FastifyInstance) {
  const server = async (id: string, reply: FastifyReply): Promise<ServerDefinition | null> => {
    const found = await findServer(id)
    if (!found) reply.code(404).send({ error: 'not_found', message: `Server "${id}" non trovato` })
    return found ?? null
  }

  const png = async (reply: FastifyReply, path: string | null) => {
    if (!path) return reply.code(404).send({ error: 'not_found', message: 'Immagine non ancora disponibile' })
    const { size } = await stat(path)
    return reply.header('Content-Type', 'image/png').header('Content-Length', size).send(createReadStream(path))
  }

  app.get<Params>('/servers/:id/map', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (s) return { data: await worldMap(s, { watching: req.query.watching === '1' }) }
  })

  // :source = livemap | world (la sorgente indicata nello stato della mappa)
  app.get<Params>('/servers/:id/map/:source/chunks/:cx/:cy', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (s) return png(reply, await mapChunkPath(s, String(req.params.source), String(req.params.cx), String(req.params.cy)))
  })

  app.get<Params>('/servers/:id/map/:source/overview', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (s) return png(reply, await mapOverviewPath(s, String(req.params.source)))
  })
}

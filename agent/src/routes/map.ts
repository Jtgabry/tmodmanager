import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { findServer, type ServerDefinition } from '../registry.js'
import { readTileTypes, SPRITE_KINDS, type SpriteKind, spritePng } from '../mapSprites.js'
import { mapChunkPath, mapOverviewPath, mapTilesPath, mapTypesPath, worldMap } from '../worldMap.js'

type Params = { Params: { id: string; source?: string; cx?: string; cy?: string; kind?: string; type?: string }; Querystring: { watching?: string } }

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

  // Vista ravvicinata con gli sprite: dati grezzi delle tile di un riquadro (gzip, li decomprime il browser)
  app.get<Params>('/servers/:id/map/:source/tiles/:cx/:cy', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const path = await mapTilesPath(s, String(req.params.source), String(req.params.cx), String(req.params.cy))
    if (!path) return reply.code(404).send({ error: 'not_found', message: 'Dati del riquadro non ancora disponibili' })
    const { size } = await stat(path)
    return reply.header('Content-Type', 'application/octet-stream').header('Content-Length', size).send(createReadStream(path))
  })

  app.get<Params>('/servers/:id/map/:source/types', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const path = req.params.source === 'livemap' ? mapTypesPath(s) : null
    const entry = path ? await readTileTypes(path) : null
    if (!entry) return reply.code(404).send({ error: 'not_found', message: 'Tipi dei blocchi non ancora disponibili' })
    return { data: entry.types }
  })

  // Sprite di un tipo di blocco o di muro delle mod (dal suo .tmod)
  app.get<Params>('/servers/:id/map/sprites/:kind/:type', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const kind = String(req.params.kind)
    const type = Number(req.params.type)
    const types = mapTypesPath(s)
    if (!SPRITE_KINDS.includes(kind as SpriteKind) || !Number.isInteger(type) || type < 0 || type > 65535 || !types) {
      return reply.code(404).send({ error: 'not_found', message: 'Sprite non trovato' })
    }
    return png(reply, await spritePng(s, types, kind as SpriteKind, type))
  })
}

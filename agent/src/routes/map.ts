import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { findServer, type ServerDefinition } from '../registry.js'
import { readTileTypes, SPRITE_KINDS, type SpriteKind, spritePng } from '../mapSprites.js'
import { changeWorldSettings, editWorld, undoWorldEdit, WorldEditorError, worldEditorCatalog, worldSettings } from '../worldEditor.js'
import { mapChunkPath, mapOverviewPath, mapTilesPath, mapTypesPath, worldMap } from '../worldMap.js'
import { tr } from '../i18n.js'

type Params = { Params: { id: string; source?: string; cx?: string; cy?: string; kind?: string; type?: string }; Querystring: { watching?: string } }

/** Mappa del mondo (sezione "Mondo"): stato, riquadri e panoramica. */
export async function mapRoutes(app: FastifyInstance) {
  const server = async (id: string, reply: FastifyReply): Promise<ServerDefinition | null> => {
    const found = await findServer(id)
    if (!found) reply.code(404).send({ error: 'not_found', message: tr('Server "{id}" not found', { id }) })
    return found ?? null
  }

  const png = async (reply: FastifyReply, path: string | null) => {
    if (!path) return reply.code(404).send({ error: 'not_found', message: tr('Image not available yet') })
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
    if (!path) return reply.code(404).send({ error: 'not_found', message: tr('Chunk data not available yet') })
    const { size } = await stat(path)
    return reply.header('Content-Type', 'application/octet-stream').header('Content-Length', size).send(createReadStream(path))
  })

  app.get<Params>('/servers/:id/map/:source/types', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const path = mapTypesPath(s, String(req.params.source))
    const entry = path ? await readTileTypes(path) : null
    if (!entry) return reply.code(404).send({ error: 'not_found', message: tr('Block types not available yet') })
    return { data: entry.types }
  })

  // Sprite di un tipo di blocco o di muro (Terraria: dalle texture del gioco; mod: dal suo .tmod)
  app.get<Params>('/servers/:id/map/:source/sprites/:kind/:type', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const kind = String(req.params.kind)
    const type = Number(req.params.type)
    const types = mapTypesPath(s, String(req.params.source))
    if (!SPRITE_KINDS.includes(kind as SpriteKind) || !Number.isInteger(type) || type < 0 || type > 65535 || !types) {
      return reply.code(404).send({ error: 'not_found', message: tr('Sprite not found') })
    }
    return png(reply, await spritePng(s, types, kind as SpriteKind, type))
  })

  // Editor del mondo a server acceso (mod LiveMap): blocchi e muri da scegliere, modifiche
  app.get<Params>('/servers/:id/map/editor/catalog', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const catalog = await worldEditorCatalog(s)
    if (!catalog) return reply.code(404).send({ error: 'not_found', message: tr('Block catalog not available (server stopped or LiveMap not active)') })
    return { data: catalog }
  })

  // Settaggi del mondo (ora, meteo, eventi, difficoltà, hardmode, spawn, boss sconfitti)
  app.get<Params>('/servers/:id/map/editor/world', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const settings = await worldSettings(s)
    if (!settings) return reply.code(404).send({ error: 'not_found', message: tr('World settings not available (server stopped or LiveMap not active)') })
    return { data: settings }
  })

  // Blocchi e muri, settaggi: stesso canale, stessi errori
  for (const [path, run] of [
    ['/servers/:id/map/editor', editWorld],
    ['/servers/:id/map/editor/settings', changeWorldSettings],
    ['/servers/:id/map/editor/undo', undoWorldEdit],
  ] as const) {
    app.post<Params & { Body: unknown }>(path, async (req, reply) => {
      const s = await server(req.params.id, reply)
      if (!s) return
      try {
        return { data: await run(s, req.body) }
      } catch (err) {
        if (!(err instanceof WorldEditorError)) throw err
        // Editor spento o server che non risponde: 409, come le altre operazioni impossibili col server in quello stato
        return err.code === 'invalid'
          ? reply.code(422).send({ error: 'invalid', message: err.message })
          : reply.code(409).send({ error: 'conflict', message: err.message })
      }
    })
  }
}

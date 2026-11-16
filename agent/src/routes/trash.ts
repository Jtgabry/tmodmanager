import type { FastifyInstance, FastifyReply } from 'fastify'
import { FileError, restoreEntry } from '../files.js'
import { ModError, restoreMod, withServerLock } from '../mods.js'
import { findServer, type ServerDefinition } from '../registry.js'
import { emptyTrash, forgetTrashItem, getTrashItem, listTrash, removeTrashItem, type TrashKind, TrashError } from '../trash.js'

type Req = {
  Params: { id: string; item?: string }
  Querystring: { kinds?: string; overwrite?: string }
}

/** Tipi di elementi visibili a chi chiede (Laravel li passa in base ai permessi: file e/o mod). */
const parseKinds = (raw: string | undefined): TrashKind[] => {
  const kinds = (raw ?? 'file,mod').split(',').filter((k): k is TrashKind => k === 'file' || k === 'mod')
  return [...new Set(kinds)]
}

export async function trashRoutes(app: FastifyInstance) {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof TrashError || err instanceof FileError || err instanceof ModError) {
      const status = err.status
      const error = status === 409 ? 'conflict' : status === 404 ? 'not_found' : 'invalid'
      return reply.code(status).send({ error, message: err.message })
    }
    throw err
  })

  const server = async (id: string, reply: FastifyReply): Promise<ServerDefinition | null> => {
    const found = await findServer(id)
    if (!found) reply.code(404).send({ error: 'not_found', message: `Server "${id}" non trovato` })
    return found ?? null
  }

  app.get<Req>('/servers/:id/trash', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (s) return { data: await listTrash(s, parseKinds(req.query.kinds)) }
  })

  app.post<Req>('/servers/:id/trash/:item/restore', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const id = String(req.params.item)
    const overwrite = req.query.overwrite === '1'
    const result = await withServerLock(s, async () => {
      const { meta, itemPath } = await getTrashItem(s, id, parseKinds(req.query.kinds))
      const restored =
        meta.kind === 'mod'
          ? await restoreMod(s, meta.modName ?? '', itemPath, overwrite)
          : await restoreEntry(s, meta, itemPath, overwrite)
      await forgetTrashItem(s, id)
      return { item: meta, ...restored }
    })
    return { data: result }
  })

  app.delete<Req>('/servers/:id/trash/:item', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    await removeTrashItem(s, String(req.params.item), parseKinds(req.query.kinds))
    return reply.code(204).send()
  })

  app.delete<Req>('/servers/:id/trash', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (s) return { data: { removed: await emptyTrash(s, parseKinds(req.query.kinds)) } }
  })
}

import type { FastifyInstance, FastifyReply } from 'fastify'
import { MOD_NAME } from '../mods.js'
import { modsOnlyForTmodloader } from './modsOnly.js'
import { findServer, type ServerDefinition } from '../registry.js'
import {
  applyPending,
  BROWSE_SORTS,
  type BrowseSort,
  browseWorkshop,
  cancelJobItem,
  checkUpdates,
  currentJob,
  dismissPending,
  fetchDetails,
  pendingMods,
  resetLink,
  searchWorkshop,
  setLink,
  startInstall,
  startInstallByName,
  startUpdate,
  WorkshopError,
  workshopItemDetails,
} from '../workshop.js'

type Params = { Params: { id: string; name?: string; workshopId?: string } }
type BrowseQuery = { Querystring: { q?: string; sort?: string; tag?: string; cursor?: string } }

const WORKSHOP_ID = /^\d{1,20}$/

const truthy = (v: unknown) => v === true || v === 'true' || v === '1'

/** Mod dello Steam Workshop: aggiornamenti, collegamenti, ricerca, installazione e mod in attesa di abilitazione. */
export async function workshopRoutes(app: FastifyInstance) {
  modsOnlyForTmodloader(app)
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof WorkshopError) {
      const error = { 404: 'not_found', 409: 'conflict', 422: 'invalid', 502: 'upstream', 503: 'unavailable' }[err.status]
      return reply.code(err.status).send({ error, message: err.message })
    }
    throw err
  })

  const server = async (id: string, reply: FastifyReply): Promise<ServerDefinition | null> => {
    const found = await findServer(id)
    if (!found) reply.code(404).send({ error: 'not_found', message: `Server "${id}" non trovato` })
    return found ?? null
  }

  const modName = (name: string | undefined) => {
    if (!name || !MOD_NAME.test(name)) throw new WorkshopError('Nome mod non valido', 422)
    return name
  }

  app.get<Params & { Querystring: { refresh?: string } }>('/servers/:id/mods/updates', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (s) return { data: await checkUpdates(s, truthy(req.query.refresh)) }
  })

  app.post<Params & { Body: { mods?: unknown } }>('/servers/:id/mods/updates', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const mods = req.body?.mods
    if (!Array.isArray(mods) || mods.length > 200 || !mods.every((m) => typeof m === 'string' && MOD_NAME.test(m))) {
      throw new WorkshopError('Campo "mods" non valido', 422)
    }
    return reply.code(202).send({ data: await startUpdate(s, mods as string[]) })
  })

  app.get<Params>('/servers/:id/mods/updates/job', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (s) return { data: currentJob(s.id) }
  })

  app.delete<Params>('/servers/:id/mods/updates/job/:name', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (s) return { data: cancelJobItem(s.id, modName(req.params.name)) }
  })

  app.put<Params & { Body: { workshop?: unknown } }>('/servers/:id/mods/:name/workshop', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const input = req.body?.workshop
    if (input !== null && (typeof input !== 'string' || input.length > 300)) throw new WorkshopError('Campo "workshop" non valido', 422)
    return { data: await setLink(s, modName(req.params.name), input) }
  })

  app.delete<Params>('/servers/:id/mods/:name/workshop', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    await resetLink(modName(req.params.name))
    return reply.code(204).send()
  })

  // Dettagli di elementi del Workshop (per il sito, che li conserva nel suo database)
  app.post<{ Body: { ids?: unknown } }>('/workshop/details', async (req) => {
    const ids = req.body?.ids
    if (!Array.isArray(ids) || ids.length > 500 || !ids.every((id) => typeof id === 'string' && /^\d{1,20}$/.test(id))) {
      throw new WorkshopError('Campo "ids" non valido', 422)
    }
    return { data: [...(await fetchDetails(ids as string[])).values()] }
  })

  app.get<{ Querystring: { q?: string } }>('/workshop/search', async (req) => ({ data: await searchWorkshop(String(req.query.q ?? '')) }))

  app.get<Params & BrowseQuery>('/servers/:id/workshop/browse', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const { q, sort, tag, cursor } = req.query
    if (sort !== undefined && !(sort in BROWSE_SORTS)) throw new WorkshopError('Ordinamento non valido', 422)
    if (tag !== undefined && (tag.length > 64 || !/^[\w .&'-]+$/.test(tag))) throw new WorkshopError('Tag non valido', 422)
    if (cursor !== undefined && cursor.length > 200) throw new WorkshopError('Cursore non valido', 422)
    return { data: await browseWorkshop(s, { q, sort: sort as BrowseSort | undefined, tag: tag || undefined, cursor: cursor || undefined }) }
  })

  app.get<Params>('/servers/:id/workshop/items/:workshopId', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    if (!WORKSHOP_ID.test(req.params.workshopId ?? '')) throw new WorkshopError('ID del Workshop non valido', 422)
    return { data: await workshopItemDetails(s, req.params.workshopId!) }
  })

  app.post<Params & { Body: { ids?: unknown } }>('/servers/:id/workshop/install', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const ids = req.body?.ids
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || !ids.every((id) => typeof id === 'string' && WORKSHOP_ID.test(id))) {
      throw new WorkshopError('Campo "ids" non valido', 422)
    }
    return reply.code(202).send({ data: await startInstall(s, ids as string[]) })
  })

  app.post<Params & { Body: { names?: unknown } }>('/servers/:id/workshop/install-names', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const names = req.body?.names
    if (!Array.isArray(names) || !names.length || names.length > 50 || !names.every((n) => typeof n === 'string' && MOD_NAME.test(n))) {
      throw new WorkshopError('Campo "names" non valido', 422)
    }
    return reply.code(202).send({ data: await startInstallByName(s, names as string[]) })
  })

  app.get<Params>('/servers/:id/workshop/pending', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (s) return { data: await pendingMods(s) }
  })

  app.post<Params>('/servers/:id/workshop/pending/apply', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (s) return { data: await applyPending(s) }
  })

  app.delete<Params>('/servers/:id/workshop/pending/:name', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    await dismissPending(s, modName(req.params.name))
    return reply.code(204).send()
  })
}

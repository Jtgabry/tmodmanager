import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Readable } from 'node:stream'
import { z } from 'zod'
import { deleteArchived, listArchive, MOD_VERSION, uploadToArchive, useArchivedVersion } from '../archive.js'
import {
  createModpack,
  deleteModpack,
  disableModpack,
  enableModpack,
  listModpacks,
  ModpackInput,
  packsPinning,
  updateModpack,
} from '../modpacks.js'
import { deleteMod, disableMods, enableMods, listMods, MOD_NAME, ModError, modPath, uploadMod, withServerLock } from '../mods.js'
import { importFromFolder, importUpload, listImportable } from '../modpackImport.js'
import { findServer, type ServerDefinition } from '../registry.js'
import { readModIcon } from '../tmod.js'
import { workshopIds } from '../workshop.js'

type Params = { Params: { id: string; name?: string; packId?: string; version?: string } }

const truthy = (v: unknown) => v === true || v === 'true' || v === '1'

export async function modRoutes(app: FastifyInstance) {
  // I .tmod arrivano come flusso binario: niente buffer in memoria
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload))

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ModError) {
      return reply.code(err.status).send({ error: err.status === 409 ? 'conflict' : 'invalid', message: err.message, details: err.details })
    }
    if (err instanceof z.ZodError) {
      return reply.code(422).send({ error: 'invalid', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') })
    }
    throw err
  })

  const server = async (id: string, reply: FastifyReply): Promise<ServerDefinition | null> => {
    const found = await findServer(id)
    if (!found) reply.code(404).send({ error: 'not_found', message: `Server "${id}" non trovato` })
    return found ?? null
  }

  const modName = (name: string | undefined) => {
    if (!name || !MOD_NAME.test(name)) throw new ModError('Nome mod non valido', 422)
    return name
  }

  // --- Mod -----------------------------------------------------------------------------------

  app.get<Params>('/servers/:id/mods', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    // Con l'ID del Workshop di ogni mod il sito può mostrare i dati della pagina (tag, anteprima…)
    const [list, ids] = await Promise.all([listMods(s), workshopIds()])
    return { data: { ...list, mods: list.mods.map((m) => ({ ...m, workshopId: ids.get(m.name) ?? null })) } }
  })

  app.put<Params & { Querystring: { enable?: string } }>('/servers/:id/mods', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    if (req.headers['content-type'] !== 'application/octet-stream') {
      throw new ModError('Invia il file .tmod come application/octet-stream', 422)
    }
    const result = await uploadMod(s, req.body as Readable, truthy(req.query.enable))
    return reply.code(result.replacedVersion ? 200 : 201).send({ data: result })
  })

  app.patch<Params & { Body: { enabled?: unknown; cascade?: unknown } }>('/servers/:id/mods/:name', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const name = modName(req.params.name)
    if (typeof req.body?.enabled !== 'boolean') throw new ModError('Campo "enabled" mancante', 422)
    const enabled = req.body.enabled
    return {
      data: await withServerLock(s, async () =>
        enabled
          ? { enabled: await enableMods(s, [name]), disabled: [] }
          : { enabled: [], disabled: await disableMods(s, [name], truthy(req.body?.cascade)) },
      ),
    }
  })

  app.delete<Params & { Querystring: { cascade?: string } }>('/servers/:id/mods/:name', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const name = modName(req.params.name)
    return { data: await withServerLock(s, () => deleteMod(s, name, truthy(req.query.cascade))) }
  })

  // Icona della mod (PNG estratto dal .tmod)
  app.get<Params>('/servers/:id/mods/:name/icon', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const icon = await readModIcon(await modPath(s, modName(req.params.name)))
    if (!icon) return reply.code(404).send({ error: 'not_found', message: 'La mod non ha un\'icona' })
    return reply.header('Content-Type', 'image/png').send(icon)
  })

  app.get<Params>('/servers/:id/mods/:name/download', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const path = await modPath(s, modName(req.params.name))
    const { size } = await stat(path)
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', size)
      .header('Content-Disposition', `attachment; filename="${req.params.name}.tmod"`)
      .send(createReadStream(path))
  })

  // --- Archivio delle versioni ------------------------------------------------------------------

  const modVersion = (version: string | undefined) => {
    if (!version || !MOD_VERSION.test(version)) throw new ModError('Versione non valida', 422)
    return version
  }

  app.get<Params>('/servers/:id/archive', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (s) return { data: await listArchive(s) }
  })

  app.put<Params>('/servers/:id/archive', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    if (req.headers['content-type'] !== 'application/octet-stream') {
      throw new ModError('Invia il file .tmod come application/octet-stream', 422)
    }
    return reply.code(201).send({ data: await uploadToArchive(s, req.body as Readable) })
  })

  app.delete<Params>('/servers/:id/archive/:name/:version', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const name = modName(req.params.name)
    const version = modVersion(req.params.version)
    await withServerLock(s, async () => {
      const packs = await packsPinning(s, name, version)
      if (packs.length) {
        throw new ModError(`La versione ${version} è bloccata nei modpack: ${packs.join(', ')}. Cambia versione lì prima di eliminarla.`, 409, { packs })
      }
      await deleteArchived(s, name, version)
    })
    return reply.code(204).send()
  })

  // Installa la versione archiviata al posto di quella attuale (che entra nell'archivio)
  app.post<Params>('/servers/:id/archive/:name/:version/use', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const name = modName(req.params.name)
    const version = modVersion(req.params.version)
    return { data: await withServerLock(s, () => useArchivedVersion(s, name, version)) }
  })

  // --- Modpack -------------------------------------------------------------------------------

  app.get<Params>('/servers/:id/modpacks', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (s) return { data: await listModpacks(s) }
  })

  app.post<Params>('/servers/:id/modpacks', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const input = ModpackInput.parse(req.body)
    return reply.code(201).send({ data: await withServerLock(s, () => createModpack(s, input)) })
  })

  app.put<Params>('/servers/:id/modpacks/:packId', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const input = ModpackInput.parse(req.body)
    return { data: await withServerLock(s, () => updateModpack(s, String(req.params.packId), input)) }
  })

  app.delete<Params>('/servers/:id/modpacks/:packId', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    await withServerLock(s, () => deleteModpack(s, String(req.params.packId)))
    return reply.code(204).send()
  })

  // --- Importazione dei modpack di tModLoader --------------------------------------------------

  app.get<Params>('/servers/:id/modpacks/importable', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (s) return { data: await listImportable(s) }
  })

  app.post<Params & { Body: { name?: unknown; replaceExisting?: unknown } }>('/servers/:id/modpacks/import', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    return reply.code(201).send({ data: await importFromFolder(s, req.body?.name, truthy(req.body?.replaceExisting)) })
  })

  app.put<Params & { Querystring: { filename?: string; replaceExisting?: string } }>('/servers/:id/modpacks/import', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    if (req.headers['content-type'] !== 'application/octet-stream') {
      throw new ModError('Invia il file come application/octet-stream', 422)
    }
    const result = await importUpload(s, req.query.filename, req.body as Readable, truthy(req.query.replaceExisting))
    return reply.code(201).send({ data: result })
  })

  for (const action of ['enable', 'disable'] as const) {
    app.post<Params>(`/servers/:id/modpacks/:packId/${action}`, async (req, reply) => {
      const s = await server(req.params.id, reply)
      if (!s) return
      const id = String(req.params.packId)
      const exclusive = truthy((req.body as { exclusive?: unknown } | undefined)?.exclusive)
      const run = (): Promise<{ enabled?: string[]; disabled?: string[]; kept?: string[] }> =>
        action === 'enable' ? enableModpack(s, id, { exclusive }) : disableModpack(s, id)
      return { data: await withServerLock(s, run) }
    })
  }
}

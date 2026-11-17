import { createReadStream } from 'node:fs'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { BackupError, backupPath, backupSchedule, createBackup, deleteBackup, listBackups, restoreBackup } from '../backups.js'
import { ConflictError, type ServerManager } from '../manager.js'
import { findServer, type ServerDefinition } from '../registry.js'

type Req = { Params: { id: string; name?: string } }

/** Backup dei mondi di un server: elenco, backup manuale, download (.zip), eliminazione. */
export async function backupRoutes(app: FastifyInstance, { manager }: { manager: ServerManager }) {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof BackupError) {
      const error = err.status === 409 ? 'conflict' : err.status === 404 ? 'not_found' : 'invalid'
      return reply.code(err.status).send({ error, message: err.message })
    }
    if (err instanceof ConflictError) return reply.code(409).send({ error: 'conflict', message: err.message })
    throw err
  })

  const server = async (id: string, reply: FastifyReply): Promise<ServerDefinition | null> => {
    const found = await findServer(id)
    if (!found) reply.code(404).send({ error: 'not_found', message: `Server "${id}" non trovato` })
    return found ?? null
  }

  app.get<Req>('/servers/:id/backups', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (s) return { data: { backups: await listBackups(s), schedule: backupSchedule() } }
  })

  app.post<Req>('/servers/:id/backups', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (s) return reply.code(201).send({ data: await createBackup(s, manager) })
  })

  app.get<Req>('/servers/:id/backups/:name/download', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const { path, size } = await backupPath(s, String(req.params.name))
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Length', size)
      .header('Content-Disposition', `attachment; filename="${req.params.name}"`)
      .send(createReadStream(path))
  })

  app.post<Req>('/servers/:id/backups/:name/restore', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (s) return { data: await restoreBackup(s, String(req.params.name), manager) }
  })

  app.delete<Req>('/servers/:id/backups/:name', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    await deleteBackup(s, String(req.params.name))
    return reply.code(204).send()
  })
}

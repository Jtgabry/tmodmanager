import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Readable } from 'node:stream'
import {
  deleteEntry,
  FileError,
  fileRoots,
  listDirectory,
  makeDirectory,
  openDownload,
  readText,
  renameEntry,
  uploadFile,
  writeText,
} from '../files.js'
import { findServer, type ServerDefinition } from '../registry.js'

type Req = {
  Params: { id: string }
  Querystring: { root?: string; path?: string; name?: string; overwrite?: string }
  Body: Record<string, unknown> | undefined
}

/** Content-Disposition con nome UTF-8 (RFC 5987) e ripiego ASCII. */
const disposition = (filename: string) =>
  `attachment; filename="${filename.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`

export async function fileRoutes(app: FastifyInstance) {
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload))

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof FileError) {
      const error = err.status === 409 ? 'conflict' : err.status === 404 ? 'not_found' : 'invalid'
      return reply.code(err.status).send({ error, message: err.message })
    }
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') return reply.code(422).send({ error: 'invalid', message: 'Permesso negato dal sistema' })
    if (code === 'ENOENT') return reply.code(404).send({ error: 'not_found', message: 'File o cartella non trovati' })
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return reply.code(409).send({ error: 'conflict', message: 'Esiste già' })
    throw err
  })

  const server = async (id: string, reply: FastifyReply): Promise<ServerDefinition | null> => {
    const found = await findServer(id)
    if (!found) reply.code(404).send({ error: 'not_found', message: `Server "${id}" non trovato` })
    return found ?? null
  }

  app.get<Req>('/servers/:id/files/roots', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (s) return { data: await fileRoots(s) }
  })

  app.get<Req>('/servers/:id/files', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (s) return { data: await listDirectory(s, req.query.root, req.query.path) }
  })

  app.get<Req>('/servers/:id/files/download', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const file = await openDownload(s, req.query.root, req.query.path)
    reply.header('Content-Type', 'application/octet-stream').header('Content-Disposition', disposition(file.filename))
    if (file.size !== null) reply.header('Content-Length', file.size)
    return reply.send(file.stream)
  })

  app.put<Req>('/servers/:id/files/upload', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    if (req.headers['content-type'] !== 'application/octet-stream') throw new FileError('Invia il file come application/octet-stream')
    const q = req.query
    const result = await uploadFile(s, q.root, q.path, q.name, req.body as unknown as Readable, q.overwrite === '1')
    return reply.code(result.replaced ? 200 : 201).send({ data: result })
  })

  app.post<Req>('/servers/:id/files/mkdir', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const b = req.body ?? {}
    return reply.code(201).send({ data: await makeDirectory(s, b.root, b.path, b.name) })
  })

  app.post<Req>('/servers/:id/files/rename', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const b = req.body ?? {}
    return { data: await renameEntry(s, b.root, b.path, b.name) }
  })

  app.delete<Req>('/servers/:id/files', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    await deleteEntry(s, req.query.root, req.query.path)
    return reply.code(204).send()
  })

  app.get<Req>('/servers/:id/files/content', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (s) return { data: await readText(s, req.query.root, req.query.path) }
  })

  app.put<Req>('/servers/:id/files/content', async (req, reply) => {
    const s = await server(req.params.id, reply)
    if (!s) return
    const b = req.body ?? {}
    return { data: await writeText(s, b.root, b.path, b.content, b.expectedModifiedAt) }
  })
}

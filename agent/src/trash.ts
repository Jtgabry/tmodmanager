import { randomBytes } from 'node:crypto'
import { cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { config } from './config.js'
import { paths } from './paths.js'
import type { ServerDefinition } from './registry.js'

/**
 * Cestino dell'agent: ogni elemento è una cartella data/servers/<server>/trash/<id>/ con
 *   meta.json  → da dove viene, quando è stato eliminato
 *   item       → il file o la cartella eliminati
 * Gli elementi più vecchi di config.trashRetentionDays vengono cancellati da purgeExpiredTrash().
 */

export class TrashError extends Error {
  constructor(
    message: string,
    public readonly status: 404 | 409 | 422 = 422,
  ) {
    super(message)
  }
}

export const TRASH_ID = /^[0-9]{13}-[0-9a-f]{8}$/

const TrashMeta = z.object({
  id: z.string().regex(TRASH_ID),
  kind: z.enum(['file', 'mod']),
  /** Nome originale del file o della cartella. */
  name: z.string(),
  /** Solo per kind=file: radice e percorso relativo originali. */
  root: z.string().nullable().default(null),
  path: z.string().nullable().default(null),
  /** Solo per kind=mod. */
  modName: z.string().nullable().default(null),
  modVersion: z.string().nullable().default(null),
  /** deleted = eliminato; replaced = copia della versione sovrascritta da un upload. */
  reason: z.enum(['deleted', 'replaced']),
  isDir: z.boolean(),
  size: z.number(),
  deletedAt: z.string(),
})
export type TrashMeta = z.infer<typeof TrashMeta>
export type TrashKind = TrashMeta['kind']

export type TrashItem = TrashMeta & { expiresAt: string; daysLeft: number }

const DAY_MS = 24 * 60 * 60 * 1000
const serverTrash = paths.trash

async function diskSize(path: string): Promise<number> {
  const info = await lstat(path)
  if (!info.isDirectory()) return info.size
  let total = 0
  for (const name of await readdir(path)) total += await diskSize(join(path, name)).catch(() => 0)
  return total
}

type NewItem = Omit<TrashMeta, 'id' | 'isDir' | 'size' | 'deletedAt'>

/** Sposta (o copia, per le sovrascritture) `absolute` nel cestino. */
export async function moveToTrash(server: ServerDefinition, absolute: string, item: NewItem, { copy = false } = {}) {
  const id = `${Date.now()}-${randomBytes(4).toString('hex')}`
  const dir = join(serverTrash(server.id), id)
  await mkdir(dir, { recursive: true })
  const info = await lstat(absolute)
  const meta: TrashMeta = {
    ...item,
    id,
    isDir: info.isDirectory(),
    size: await diskSize(absolute),
    deletedAt: new Date().toISOString(),
  }
  const target = join(dir, 'item')
  try {
    if (copy) await cp(absolute, target, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
    else await move(absolute, target)
    await writeFile(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  } catch (err) {
    await rm(dir, { recursive: true, force: true })
    throw err
  }
  return meta
}

/** rename, oppure copia + rimozione tra filesystem diversi. */
export async function move(from: string, to: string) {
  try {
    await rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await cp(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
    await rm(from, { recursive: true, force: true })
  }
}

function withExpiry(meta: TrashMeta, now = Date.now()): TrashItem {
  const expires = Date.parse(meta.deletedAt) + config.trashRetentionDays * DAY_MS
  return {
    ...meta,
    expiresAt: new Date(expires).toISOString(),
    daysLeft: Math.max(0, Math.ceil((expires - now) / DAY_MS)),
  }
}

async function readMeta(serverId: string, id: string): Promise<TrashMeta | null> {
  try {
    return TrashMeta.parse(JSON.parse(await readFile(join(serverTrash(serverId), id, 'meta.json'), 'utf8')))
  } catch {
    return null
  }
}

export async function listTrash(server: ServerDefinition, kinds: TrashKind[]): Promise<TrashItem[]> {
  let ids: string[]
  try {
    ids = (await readdir(serverTrash(server.id))).filter((n) => TRASH_ID.test(n))
  } catch {
    return []
  }
  const metas = await Promise.all(ids.map((id) => readMeta(server.id, id)))
  const now = Date.now()
  return metas
    .filter((m): m is TrashMeta => m !== null && kinds.includes(m.kind))
    .map((m) => withExpiry(m, now))
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
}

/** Elemento del cestino, solo se di uno dei tipi consentiti a chi chiede. */
export async function getTrashItem(server: ServerDefinition, id: string, kinds: TrashKind[]) {
  if (!TRASH_ID.test(id)) throw new TrashError('Elemento non valido', 422)
  const meta = await readMeta(server.id, id)
  if (!meta || !kinds.includes(meta.kind)) throw new TrashError('Elemento non trovato nel cestino', 404)
  return { meta, itemPath: join(serverTrash(server.id), id, 'item') }
}

export async function removeTrashItem(server: ServerDefinition, id: string, kinds: TrashKind[]) {
  await getTrashItem(server, id, kinds)
  await rm(join(serverTrash(server.id), id), { recursive: true, force: true })
}

/** Toglie dal cestino la cartella dell'elemento (dopo che `item` è stato ripristinato altrove). */
export async function forgetTrashItem(server: ServerDefinition, id: string) {
  await rm(join(serverTrash(server.id), id), { recursive: true, force: true })
}

export async function emptyTrash(server: ServerDefinition, kinds: TrashKind[]) {
  const items = await listTrash(server, kinds)
  for (const item of items) await rm(join(serverTrash(server.id), item.id), { recursive: true, force: true })
  return items.length
}

/** Cancella gli elementi scaduti di tutti i server (anche di server non più nel registry). */
export async function purgeExpiredTrash(now = Date.now()): Promise<number> {
  let removed = 0
  let servers: string[]
  try {
    servers = await readdir(paths.serversRoot())
  } catch {
    return 0
  }
  for (const serverId of servers) {
    let ids: string[]
    try {
      ids = await readdir(serverTrash(serverId))
    } catch {
      continue
    }
    for (const id of ids) {
      const dir = join(serverTrash(serverId), id)
      const meta = await readMeta(serverId, id)
      // Elementi senza meta (vecchio formato o scrittura interrotta): l'età si ricava dal nome o dal mtime
      const deletedAt = meta
        ? Date.parse(meta.deletedAt)
        : TRASH_ID.test(id)
          ? Number(id.slice(0, 13))
          : (await lstat(dir).catch(() => null))?.mtimeMs ?? now
      if (now - deletedAt > config.trashRetentionDays * DAY_MS) {
        await rm(dir, { recursive: true, force: true })
        removed++
      }
    }
  }
  return removed
}

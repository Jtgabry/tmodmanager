import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import type { ServerDefinition } from './registry.js'

/**
 * Editor del mondo a server acceso, tramite la mod LiveMap (addons/TmmLiveMap/WorldEditor.cs): il pannello scrive
 * un comando in <save>/LiveMap/editor/inbox/, la mod lo esegue sul thread di gioco (i giocatori vedono subito la
 * modifica) e scrive l'esito in outbox/. Prototipo: solo tModLoader.
 */

export class WorldEditorError extends Error {
  constructor(
    message: string,
    readonly code: 'unavailable' | 'invalid' | 'timeout',
  ) {
    super(message)
  }
}

/** La mod tocca "alive" ogni 2 secondi: oltre questo, l'editor non risponde (server spento, mod disattivata). */
const ALIVE_MS = 10_000
/** Attesa dell'esito: la mod guarda la cartella 10 volte al secondo. Dopo, il comando si ritira (la mod scarta quelli vecchi). */
const RESULT_TIMEOUT_MS = 5_000
export const MAX_OPS = 4096

const editorDir = (server: ServerDefinition) => (server.game === 'tmodloader' ? join(server.saveDir, 'LiveMap', 'editor') : null)

/** L'editor risponde su questo server (mod LiveMap attiva, mondo caricato). */
export async function worldEditorAvailable(server: ServerDefinition): Promise<boolean> {
  const dir = editorDir(server)
  if (!dir) return false
  const alive = await stat(join(dir, 'alive')).catch(() => null)
  return alive !== null && Date.now() - alive.mtimeMs < ALIVE_MS
}

const Coord = z.number().int().min(0).max(65535)
export const EditOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('place-tile'), x: Coord, y: Coord, type: z.number().int().min(0).max(65535), style: z.number().int().min(0).max(1000).default(0) }),
  z.object({ op: z.literal('kill-tile'), x: Coord, y: Coord }),
  z.object({ op: z.literal('place-wall'), x: Coord, y: Coord, type: z.number().int().min(1).max(65535) }),
  z.object({ op: z.literal('kill-wall'), x: Coord, y: Coord }),
])
export type EditOp = z.infer<typeof EditOp>
const EditRequest = z.object({ ops: z.array(EditOp).min(1).max(MAX_OPS) })

const EditResult = z.object({
  applied: z.number(),
  failed: z.number(),
  failures: z.array(z.object({ index: z.number(), x: z.number(), y: z.number(), reason: z.string() })),
  error: z.string().optional(),
})
export type EditResult = z.infer<typeof EditResult>

/** Applica le modifiche e ne restituisce l'esito (quante riuscite, perché le altre no). */
export async function editWorld(server: ServerDefinition, body: unknown): Promise<EditResult> {
  const parsed = EditRequest.safeParse(body)
  if (!parsed.success) throw new WorldEditorError(`Modifiche non valide: ${parsed.error.issues[0]?.message ?? 'formato'}`, 'invalid')
  const dir = editorDir(server)
  if (!dir || !(await worldEditorAvailable(server))) {
    throw new WorldEditorError("L'editor non è disponibile: serve il server acceso con la mod LiveMap attiva", 'unavailable')
  }

  const id = `${Date.now()}-${randomUUID()}`
  const inbox = join(dir, 'inbox')
  const command = join(inbox, `${id}.json`)
  const output = join(dir, 'outbox', `${id}.json`)
  await mkdir(inbox, { recursive: true })
  await writeFile(join(inbox, `${id}.tmp`), JSON.stringify({ createdAt: Date.now(), ops: parsed.data.ops }))
  await rename(join(inbox, `${id}.tmp`), command)

  const deadline = Date.now() + RESULT_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(50)
    const raw = await readFile(output, 'utf8').catch(() => null)
    if (raw === null) continue
    await rm(output, { force: true })
    const result = EditResult.safeParse(JSON.parse(raw))
    if (!result.success) throw new WorldEditorError('Risposta della mod non valida', 'invalid')
    if (result.data.error) throw new WorldEditorError(result.data.error, 'invalid')
    return result.data
  }
  // Ritirato: se la mod lo prende comunque, l'esito resta in outbox finché non lo cancella al prossimo avvio
  await rm(command, { force: true })
  throw new WorldEditorError('Il server non ha risposto in tempo: modifica annullata', 'timeout')
}

const CatalogEntry = z.object({ type: z.number(), name: z.string(), mod: z.string().optional(), object: z.boolean().optional() })
const Catalog = z.object({ format: z.literal(1), tiles: z.array(CatalogEntry), walls: z.array(CatalogEntry) })
export type WorldEditorCatalog = z.infer<typeof Catalog>

/** Blocchi e muri che si possono piazzare (scritti dalla mod a ogni caricamento del mondo), null se non ci sono. */
export async function worldEditorCatalog(server: ServerDefinition): Promise<WorldEditorCatalog | null> {
  const dir = editorDir(server)
  if (!dir) return null
  try {
    const parsed = Catalog.safeParse(JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

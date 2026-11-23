import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import type { ServerDefinition } from './registry.js'
import { tr, trText } from './i18n.js'

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
  /** setting: settaggio del mondo non cambiato (allora index = -1). */
  failures: z.array(z.object({ index: z.number(), x: z.number(), y: z.number(), reason: z.string(), setting: z.string().optional() })),
  error: z.string().optional(),
  /** Modifica di blocchi e muri che ha cambiato qualcosa: id per annullarla (undoWorldEdit). */
  undoId: z.string().optional(),
})
export type EditResult = z.infer<typeof EditResult>

/** Applica le modifiche e ne restituisce l'esito (quante riuscite, perché le altre no). */
export async function editWorld(server: ServerDefinition, body: unknown): Promise<EditResult> {
  const parsed = EditRequest.safeParse(body)
  if (!parsed.success) throw new WorldEditorError(tr('Invalid changes: {error}', { error: parsed.error.issues[0]?.message ?? 'format' }), 'invalid')
  return sendCommand(server, { ops: parsed.data.ops })
}

/** Id dei comandi scritti da sendCommand (anche nel nome del file: niente altro che questo formato). */
const UndoRequest = z.object({ id: z.string().regex(/^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/) })

/**
 * Annulla una modifica di blocchi e muri (l'undoId del suo esito). La mod rimette le tile di prima solo dove il mondo
 * è ancora come l'aveva lasciato la modifica; le altre le conta come non riuscite ("changed since").
 */
export async function undoWorldEdit(server: ServerDefinition, body: unknown): Promise<EditResult> {
  const parsed = UndoRequest.safeParse(body)
  if (!parsed.success) throw new WorldEditorError(tr('Invalid undo request'), 'invalid')
  return sendCommand(server, { undo: parsed.data.id })
}

/** Boss di Terraria che si possono segnare come sconfitti (wallOfFlesh si legge soltanto: è l'hardmode). */
export const BOSSES = [
  'slimeKing', 'eyeOfCthulhu', 'evilBoss', 'queenBee', 'skeletron', 'deerclops', 'wallOfFlesh', 'queenSlime', 'destroyer', 'twins',
  'skeletronPrime', 'plantera', 'golem', 'dukeFishron', 'empressOfLight', 'lunaticCultist', 'moonLord',
] as const

const WorldSettingsState = z.object({
  clock: z.number(),
  day: z.boolean(),
  rain: z.boolean(),
  sandstorm: z.boolean(),
  bloodMoon: z.boolean(),
  eclipse: z.boolean(),
  moonPhase: z.number(),
  gameMode: z.number(),
  hardMode: z.boolean(),
  generatingHardMode: z.boolean(),
  spawnX: z.number(),
  spawnY: z.number(),
  bosses: z.record(z.string(), z.boolean()),
})
export type WorldSettingsState = z.infer<typeof WorldSettingsState>

const WorldSettingsChanges = z
  .object({
    /** Minuti dalla mezzanotte. */
    clock: z.number().int().min(0).max(1439),
    rain: z.boolean(),
    sandstorm: z.boolean(),
    bloodMoon: z.boolean(),
    eclipse: z.boolean(),
    moonPhase: z.number().int().min(0).max(7),
    /** 0 classica, 1 esperto, 2 maestro (Viaggio no: i personaggi devono essere di quel tipo). */
    gameMode: z.number().int().min(0).max(2),
    hardMode: z.boolean(),
    spawn: z.object({ x: Coord, y: Coord }),
    bosses: z.partialRecord(z.enum(BOSSES).exclude(['wallOfFlesh']), z.boolean()),
  })
  .partial()
  .strict()
  .refine((c) => Object.keys(c).length > 0, 'no setting to change')

/** Settaggi del mondo come li vede la mod adesso (li riscrive ogni 2 secondi), null se l'editor non risponde. */
export async function worldSettings(server: ServerDefinition): Promise<WorldSettingsState | null> {
  const dir = editorDir(server)
  if (!dir || !(await worldEditorAvailable(server))) return null
  try {
    const parsed = WorldSettingsState.safeParse(JSON.parse(await readFile(join(dir, 'world.json'), 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Cambia i settaggi del mondo (solo quelli indicati); l'esito dice quali non si sono potuti cambiare e perché. */
export async function changeWorldSettings(server: ServerDefinition, body: unknown): Promise<EditResult> {
  const parsed = WorldSettingsChanges.safeParse(body)
  if (!parsed.success) throw new WorldEditorError(tr('Invalid settings: {error}', { error: parsed.error.issues[0]?.message ?? 'format' }), 'invalid')
  const { spawn, ...rest } = parsed.data
  return sendCommand(server, { settings: { ...rest, ...(spawn ? { spawnX: spawn.x, spawnY: spawn.y } : {}) } })
}

/** Scrive un comando per la mod e ne aspetta l'esito. */
async function sendCommand(server: ServerDefinition, payload: { ops: EditOp[] } | { settings: object } | { undo: string }): Promise<EditResult> {
  const dir = editorDir(server)
  if (!dir || !(await worldEditorAvailable(server))) {
    throw new WorldEditorError(tr('The editor is not available: the server must be running with the LiveMap mod active'), 'unavailable')
  }

  const id = `${Date.now()}-${randomUUID()}`
  const inbox = join(dir, 'inbox')
  const command = join(inbox, `${id}.json`)
  const output = join(dir, 'outbox', `${id}.json`)
  await mkdir(inbox, { recursive: true })
  await writeFile(join(inbox, `${id}.tmp`), JSON.stringify({ createdAt: Date.now(), ...payload }))
  await rename(join(inbox, `${id}.tmp`), command)

  const deadline = Date.now() + RESULT_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(50)
    const raw = await readFile(output, 'utf8').catch(() => null)
    if (raw === null) continue
    await rm(output, { force: true })
    const result = EditResult.safeParse(JSON.parse(raw))
    if (!result.success) throw new WorldEditorError(tr('Invalid response from the mod'), 'invalid')
    if (result.data.error) throw new WorldEditorError(trText(result.data.error), 'invalid')
    return { ...result.data, failures: result.data.failures.map((f) => ({ ...f, reason: trText(f.reason) })) }
  }
  // Ritirato: se la mod lo prende comunque, l'esito resta in outbox finché non lo cancella al prossimo avvio
  await rm(command, { force: true })
  throw new WorldEditorError(tr('The server did not respond in time: change cancelled'), 'timeout')
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

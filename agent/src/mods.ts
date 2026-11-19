import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isModAddon } from './addons.js'
import { paths } from './paths.js'
import type { ServerDefinition } from './registry.js'
import { type ModInfo, readModInfo, sideName, TmodError } from './tmod.js'
import { moveToArchive } from './archive.js'
import { moveToTrash } from './trash.js'

/** Errore di input (422) o conflitto (409), con dettagli strutturati per il client. */
export class ModError extends Error {
  constructor(
    message: string,
    public readonly status: 409 | 404 | 413 | 422 = 422,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

export const MOD_NAME = /^[A-Za-z0-9_]{1,64}$/
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024

export const modsDir = (server: ServerDefinition) => join(server.saveDir, 'Mods')
const enabledPath = (server: ServerDefinition) => join(modsDir(server), 'enabled.json')
export const tmpDir = paths.tmp

// --- Lock per server: le modifiche a Mods/ ed enabled.json non si sovrappongono ---------------

const locks = new Map<string, Promise<unknown>>()

export function withServerLock<T>(server: ServerDefinition, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(server.id) ?? Promise.resolve()
  const next = previous.then(task)
  // La coda non deve mai essere rifiutata: l'errore lo gestisce chi ha chiamato (tramite `next`)
  const tail = next.then(
    () => undefined,
    () => undefined,
  )
  locks.set(server.id, tail)
  void tail.then(() => {
    if (locks.get(server.id) === tail) locks.delete(server.id)
  })
  return next
}

// --- enabled.json ----------------------------------------------------------------------------

export async function readEnabled(server: ServerDefinition): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(enabledPath(server), 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : []
  } catch {
    return []
  }
}

/** Scrittura atomica, nello stesso formato di tModLoader (array JSON indentato). */
async function writeEnabled(server: ServerDefinition, names: string[]) {
  const unique = [...new Set(names)]
  const tmp = `${enabledPath(server)}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, `${JSON.stringify(unique, null, 2)}\n`)
  await rename(tmp, enabledPath(server))
}

// --- Lettura delle mod -------------------------------------------------------------------------

/** Il file è lo stesso se coincidono inode, dimensione e data: un .tmod sostituito con rename cambia inode. */
type CachedInfo = { ino: number; mtimeMs: number; size: number; info: ModInfo | null; error: string | null }
const infoCache = new Map<string, CachedInfo>()

async function cachedInfo(path: string): Promise<CachedInfo> {
  const { ino, mtimeMs, size } = await stat(path)
  const hit = infoCache.get(path)
  if (hit && hit.ino === ino && hit.mtimeMs === mtimeMs && hit.size === size) return hit
  let entry: CachedInfo
  try {
    entry = { ino, mtimeMs, size, info: await readModInfo(path), error: null }
  } catch (err) {
    entry = { ino, mtimeMs, size, info: null, error: err instanceof Error ? err.message : String(err) }
  }
  infoCache.set(path, entry)
  return entry
}

export type ModEntry = {
  /** Nome interno (quello di enabled.json); per file illeggibili, il nome del file. */
  name: string
  file: string
  displayName: string | null
  version: string | null
  tmlVersion: string | null
  author: string | null
  description: string | null
  homepage: string | null
  side: string | null
  dependencies: string[]
  optionalDependencies: string[]
  size: number
  modifiedAt: string
  enabled: boolean
  /** Dipendenze obbligatorie non presenti nella cartella. */
  missingDependencies: string[]
  /** Il .tmod contiene un'icona (servita da /mods/:name/icon). */
  hasIcon: boolean
  /** Il file non è un .tmod leggibile. */
  error: string | null
  /** Add-on di tModManager (es. LiveMap): si aggiorna con il pannello, mai collegato al Workshop né esportato. */
  addon: boolean
}

export async function listMods(server: ServerDefinition): Promise<{ mods: ModEntry[]; missingEnabled: string[] }> {
  let files: string[] = []
  try {
    files = (await readdir(modsDir(server))).filter((f) => f.toLowerCase().endsWith('.tmod'))
  } catch {
    // cartella Mods assente: nessuna mod
  }
  const enabled = new Set(await readEnabled(server))

  const mods = await Promise.all(
    files.map(async (file): Promise<ModEntry> => {
      const { info, error, size, mtimeMs } = await cachedInfo(join(modsDir(server), file))
      const name = info?.name ?? file.replace(/\.tmod$/i, '')
      return {
        name,
        file,
        displayName: info?.displayName ?? null,
        version: info?.version ?? null,
        tmlVersion: info?.tmlVersion ?? null,
        author: info?.author ?? null,
        description: info?.description ?? null,
        homepage: info?.homepage ?? null,
        side: info ? sideName(info.side) : null,
        hasIcon: info?.hasIcon ?? false,
        dependencies: info?.modReferences ?? [],
        optionalDependencies: info?.weakReferences ?? [],
        size,
        modifiedAt: new Date(mtimeMs).toISOString(),
        enabled: enabled.has(name),
        missingDependencies: [],
        error,
        addon: isModAddon(name),
      }
    }),
  )

  const present = new Set(mods.map((m) => m.name))
  for (const mod of mods) mod.missingDependencies = mod.dependencies.filter((d) => !present.has(d))
  mods.sort((a, b) => (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name, 'it', { sensitivity: 'base' }))

  return { mods, missingEnabled: [...enabled].filter((n) => !present.has(n)).sort() }
}

/**
 * Impronta dello stato delle mod (file presenti + abilitate). Confrontata con quella presa quando
 * il server era acceso, dice se serve un riavvio. Non si usano le date: tModLoader riscrive
 * enabled.json da solo durante l'avvio.
 */
export async function modsFingerprint(server: ServerDefinition): Promise<string> {
  let files: string[] = []
  try {
    files = (await readdir(modsDir(server))).filter((f) => f.toLowerCase().endsWith('.tmod')).sort()
  } catch {
    // nessuna cartella Mods
  }
  const parts = await Promise.all(
    files.map(async (f) => {
      const { size, mtimeMs } = await stat(join(modsDir(server), f)).catch(() => ({ size: 0, mtimeMs: 0 }))
      return `${f}:${size}:${Math.round(mtimeMs)}`
    }),
  )
  const enabled = [...new Set(await readEnabled(server))].sort()
  return JSON.stringify({ files: parts, enabled })
}

// --- Dipendenze ----------------------------------------------------------------------------------

type Graph = Map<string, string[]>
const graphOf = (mods: ModEntry[]): Graph => new Map(mods.map((m) => [m.name, m.dependencies]))

/** Tutte le dipendenze (ricorsive) dei nomi dati, nomi inclusi. */
export function dependencyClosure(graph: Graph, names: string[]): Set<string> {
  const result = new Set<string>()
  const visit = (name: string) => {
    if (result.has(name)) return
    result.add(name)
    for (const dep of graph.get(name) ?? []) visit(dep)
  }
  names.forEach(visit)
  return result
}

/** Mod abilitate che dipendono (anche indirettamente) da `name`. */
export function enabledDependents(graph: Graph, enabled: Iterable<string>, name: string): string[] {
  return [...enabled].filter((other) => other !== name && dependencyClosure(graph, [other]).has(name)).sort()
}

// --- Operazioni ------------------------------------------------------------------------------

/**
 * Abilita mod con le loro dipendenze. Restituisce i nomi effettivamente aggiunti.
 * Se manca una dipendenza obbligatoria, non cambia nulla (422).
 */
export async function enableMods(server: ServerDefinition, names: string[]): Promise<string[]> {
  const { mods } = await listMods(server)
  const graph = graphOf(mods)
  const unknown = names.filter((n) => !graph.has(n))
  if (unknown.length) throw new ModError(`Mod non presenti: ${unknown.join(', ')}`, 404, { missing: unknown })

  const wanted = dependencyClosure(graph, names)
  const missing = [...wanted].filter((n) => !graph.has(n))
  if (missing.length) {
    throw new ModError(`Dipendenze mancanti: ${missing.join(', ')}. Caricale prima di abilitare.`, 422, { missing })
  }

  const enabled = await readEnabled(server)
  const added = [...wanted].filter((n) => !enabled.includes(n))
  if (added.length) await writeEnabled(server, [...enabled, ...added])
  return added
}

/**
 * Disabilita mod. Se altre mod abilitate ne dipendono: con `cascade` le disabilita anche,
 * altrimenti 409 con l'elenco. Restituisce i nomi effettivamente rimossi.
 */
export async function disableMods(server: ServerDefinition, names: string[], cascade: boolean): Promise<string[]> {
  const { mods } = await listMods(server)
  const graph = graphOf(mods)
  const enabled = await readEnabled(server)
  const removing = new Set(names)

  const dependents = [
    ...new Set(names.flatMap((n) => enabledDependents(graph, enabled, n)).filter((d) => !removing.has(d))),
  ].sort()
  if (dependents.length && !cascade) {
    throw new ModError(`Altre mod abilitate dipendono da questa: ${dependents.join(', ')}`, 409, { dependents })
  }
  dependents.forEach((d) => removing.add(d))

  const removed = enabled.filter((n) => removing.has(n))
  if (removed.length) await writeEnabled(server, enabled.filter((n) => !removing.has(n)))
  return removed
}

export async function modPath(server: ServerDefinition, name: string): Promise<string> {
  if (!MOD_NAME.test(name)) throw new ModError('Nome mod non valido', 422)
  const { mods } = await listMods(server)
  const mod = mods.find((m) => m.name === name)
  if (!mod) throw new ModError(`Mod "${name}" non trovata`, 404)
  return join(modsDir(server), mod.file)
}

/** Sposta il file nel cestino dell'agent e la toglie da enabled.json. */
export async function deleteMod(server: ServerDefinition, name: string, cascade: boolean) {
  const path = await modPath(server, name)
  const mod = (await listMods(server)).mods.find((m) => m.name === name)
  const enabled = await readEnabled(server)
  const removed = enabled.includes(name) ? await disableMods(server, [name], cascade) : []

  await moveToTrash(server, path, {
    kind: 'mod',
    name: `${name}.tmod`,
    root: null,
    path: null,
    modName: name,
    modVersion: mod?.version ?? null,
    reason: 'deleted',
  })
  return { disabled: removed }
}

/**
 * Rimette in Mods/ una mod dal cestino (disabilitata, salvo che sia ancora in enabled.json).
 * Se è installata un'altra versione: 409, oppure (overwrite) quella attuale va nel cestino.
 */
export async function restoreMod(server: ServerDefinition, modName: string, from: string, overwrite: boolean) {
  if (!MOD_NAME.test(modName)) throw new ModError('Nome mod non valido', 422)
  const current = (await listMods(server)).mods.find((m) => m.name === modName)
  if (current && !overwrite) {
    throw new ModError(`La mod "${modName}" è già installata (versione ${current.version ?? '?'})`, 409)
  }
  await mkdir(modsDir(server), { recursive: true })
  const staging = join(modsDir(server), `.${modName}.tmod.restoring`)
  // La versione installata ora lascia il posto a quella ripristinata: va nell'archivio
  if (current) await retireVersion(server, join(modsDir(server), current.file), current, 'replaced')
  await moveFile(from, staging)
  await rename(staging, join(modsDir(server), `${modName}.tmod`))
  return { replacedVersion: current?.version ?? null }
}

export type UploadResult = {
  mod: ModEntry
  /** Versione sostituita, se la mod esisteva già (aggiornamento). */
  replacedVersion: string | null
  enabled: string[]
  warning: string | null
}

/**
 * Riceve un .tmod in streaming, lo valida e lo salva come Mods/<NomeInterno>.tmod.
 * Se la mod esiste già, la versione precedente va nel cestino.
 */
export async function uploadMod(server: ServerDefinition, body: Readable, enable: boolean): Promise<UploadResult> {
  await mkdir(tmpDir(), { recursive: true })
  const tmp = join(tmpDir(), `upload-${randomBytes(8).toString('hex')}.tmod`)
  try {
    let received = 0
    body.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_UPLOAD_BYTES) body.destroy(new ModError('File troppo grande (max 1 GB)', 413))
    })
    await pipeline(body, createWriteStream(tmp))

    let info: ModInfo
    try {
      info = await readModInfo(tmp)
    } catch (err) {
      throw new ModError(err instanceof TmodError ? err.message : 'File .tmod non leggibile', 422)
    }

    return await withServerLock(server, () => installModFile(server, tmp, info, enable))
  } finally {
    await rm(tmp, { force: true })
  }
}

/**
 * Installa un .tmod già validato (lo sposta da `file`). Da chiamare dentro withServerLock.
 * Se la mod esiste già, la versione precedente va nel cestino (da lì si può ripristinare).
 */
export async function installModFile(server: ServerDefinition, file: string, info: ModInfo, enable: boolean): Promise<UploadResult> {
  await mkdir(modsDir(server), { recursive: true })
  const { mods } = await listMods(server)
  const existing = mods.find((m) => m.name === info.name)
  const target = join(modsDir(server), `${info.name}.tmod`)

  // Copia accanto alla destinazione e rename: chi legge Mods/ non vede mai un file a metà
  const staging = join(modsDir(server), `.${info.name}.tmod.uploading`)
  await moveFile(file, staging)
  // La versione sostituita entra nell'archivio delle versioni (nel cestino solo se è la stessa versione)
  if (existing) await retireVersion(server, join(modsDir(server), existing.file), existing, existing.version === info.version ? 'same' : 'replaced')
  await rename(staging, target)

  let enabled: string[] = []
  let warning: string | null = null
  const wasEnabled = (await readEnabled(server)).includes(info.name)
  if (enable || wasEnabled) {
    try {
      enabled = await enableMods(server, [info.name])
    } catch (err) {
      if (!(err instanceof ModError)) throw err
      warning = `Caricata ma non abilitata: ${err.message}`
    }
  }

  const mod = (await listMods(server)).mods.find((m) => m.name === info.name)
  if (!mod) throw new Error('Mod caricata ma non trovata nella cartella')
  return { mod, replacedVersion: existing?.version ?? null, enabled, warning }
}

/**
 * Toglie da Mods/ una versione che viene sostituita: nell'archivio delle versioni, oppure nel
 * cestino se è la stessa versione che sta arrivando (o se la versione non si può archiviare).
 */
async function retireVersion(server: ServerDefinition, path: string, mod: ModEntry, kind: 'same' | 'replaced') {
  if (kind === 'replaced' && mod.version && (await moveToArchive(server, path, { name: mod.name, version: mod.version }))) return
  await moveToTrash(server, path, {
    kind: 'mod',
    name: mod.file,
    root: null,
    path: null,
    modName: mod.name,
    modVersion: mod.version ?? null,
    reason: 'replaced',
  })
}

/** rename, con ripiego su copia+cancellazione se sorgente e destinazione sono su filesystem diversi. */
async function moveFile(from: string, to: string) {
  try {
    await rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await copyFile(from, to)
    await unlink(from)
  }
}

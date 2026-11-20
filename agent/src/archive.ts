import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, readdir, rename, rm, rmdir, stat, unlink, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { paths } from './paths.js'
import { installModFile, listMods, MOD_NAME, ModError, tmpDir, type UploadResult, withServerLock } from './mods.js'
import type { ServerDefinition } from './registry.js'
import { compareVersions } from './tml.js'
import { type ModInfo, readModInfo, TmodError } from './tmod.js'
import { tr } from './i18n.js'

/**
 * Archivio delle versioni delle mod, per server: le versioni NON installate di ogni mod, così un
 * modpack può bloccare una versione e tornarci quando viene attivato.
 *
 * Si riempie da solo (la versione sostituita da un aggiornamento o da un caricamento finisce qui
 * invece che nel cestino) oppure a mano, caricando un .tmod. Passare a una versione archiviata la
 * scambia con quella installata, che a sua volta entra nell'archivio: niente copie doppie.
 *
 * Su disco: <dataDir>/servers/<server>/archive/<NomeMod>/<versione>.tmod
 */

/** Versione di una mod (System.Version di .NET: da 1 a 4 numeri). */
export const MOD_VERSION = /^\d{1,9}(\.\d{1,9}){0,3}$/
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024

const archiveRoot = (server: ServerDefinition) => paths.archive(server.id)
const modDir = (server: ServerDefinition, name: string) => join(archiveRoot(server), name)
const versionPath = (server: ServerDefinition, name: string, version: string) => join(modDir(server, name), `${version}.tmod`)

export type ArchivedVersion = {
  version: string
  /** tModLoader con cui è stata compilata. */
  tmlVersion: string
  size: number
  /** Quando è entrata nell'archivio. */
  archivedAt: string
}

export type ArchiveEntry = {
  name: string
  displayName: string | null
  /** Versione installata ora (null se la mod non è installata). */
  installedVersion: string | null
  /** Versioni archiviate, dalla più recente. */
  versions: ArchivedVersion[]
}

const infoCache = new Map<string, { mtimeMs: number; size: number; info: ModInfo }>()

async function archivedInfo(path: string): Promise<{ info: ModInfo; size: number; mtimeMs: number } | null> {
  try {
    const { mtimeMs, size } = await stat(path)
    const hit = infoCache.get(path)
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit
    const entry = { mtimeMs, size, info: await readModInfo(path) }
    infoCache.set(path, entry)
    return entry
  } catch {
    return null
  }
}

async function readDirSafe(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}

/** Versioni archiviate di una mod (file illeggibili ignorati), dalla più recente. */
export async function archivedVersions(server: ServerDefinition, name: string): Promise<(ArchivedVersion & { displayName: string | null })[]> {
  const files = (await readDirSafe(modDir(server, name))).filter((f) => f.endsWith('.tmod') && MOD_VERSION.test(f.slice(0, -5)))
  const versions = await Promise.all(
    files.map(async (file) => {
      const found = await archivedInfo(join(modDir(server, name), file))
      if (!found || found.info.name !== name) return null
      return {
        version: found.info.version,
        tmlVersion: found.info.tmlVersion,
        size: found.size,
        archivedAt: new Date(found.mtimeMs).toISOString(),
        displayName: found.info.displayName,
      }
    }),
  )
  return versions.filter((v) => v !== null).sort((a, b) => compareVersions(b.version, a.version))
}

/** Tutto l'archivio del server, per mod. */
export async function listArchive(server: ServerDefinition): Promise<ArchiveEntry[]> {
  const names = (await readDirSafe(archiveRoot(server))).filter((n) => MOD_NAME.test(n))
  const { mods } = await listMods(server)
  const entries = await Promise.all(
    names.map(async (name): Promise<ArchiveEntry | null> => {
      const versions = await archivedVersions(server, name)
      if (!versions.length) return null
      const installed = mods.find((m) => m.name === name)
      return {
        name,
        displayName: installed?.displayName ?? versions[0].displayName,
        installedVersion: installed?.version ?? null,
        versions: versions.map(({ displayName: _d, ...v }) => v),
      }
    }),
  )
  return entries.filter((e) => e !== null).sort((a, b) => (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name, 'it', { sensitivity: 'base' }))
}

export async function hasArchivedVersion(server: ServerDefinition, name: string, version: string): Promise<boolean> {
  if (!MOD_NAME.test(name) || !MOD_VERSION.test(version)) return false
  return (await archivedInfo(versionPath(server, name, version)))?.info.name === name
}

/** Percorso del .tmod di una versione archiviata (null se non c'è o non è valida). */
export async function archivedVersionPath(server: ServerDefinition, name: string, version: string): Promise<string | null> {
  return (await hasArchivedVersion(server, name, version)) ? versionPath(server, name, version) : null
}

/** rename, con ripiego su copia+cancellazione tra filesystem diversi. */
async function moveFile(from: string, to: string) {
  try {
    await rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await copyFile(from, to)
    await unlink(from)
  }
}

/**
 * Sposta nell'archivio un .tmod già letto (`info`). Se quella versione c'era già, viene sostituita.
 * Restituisce false se la versione non ha un formato utilizzabile come nome di file (il chiamante decide).
 */
export async function moveToArchive(server: ServerDefinition, file: string, info: Pick<ModInfo, 'name' | 'version'>): Promise<boolean> {
  if (!MOD_NAME.test(info.name) || !MOD_VERSION.test(info.version)) return false
  await mkdir(modDir(server, info.name), { recursive: true })
  const target = versionPath(server, info.name, info.version)
  const staging = `${target}.${randomBytes(4).toString('hex')}.tmp`
  await moveFile(file, staging)
  // La data del file diventa quella di archiviazione (mostrata nell'elenco)
  const now = new Date()
  await utimes(staging, now, now)
  await rename(staging, target)
  return true
}

/** Carica a mano un .tmod nell'archivio (non tocca la mod installata). */
export async function uploadToArchive(server: ServerDefinition, body: Readable): Promise<{ name: string } & ArchivedVersion> {
  await mkdir(tmpDir(), { recursive: true })
  const tmp = join(tmpDir(), `archive-${randomBytes(8).toString('hex')}.tmod`)
  try {
    let received = 0
    body.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_UPLOAD_BYTES) body.destroy(new ModError(tr('File too large (max {size})', { size: '1 GB' }), 413))
    })
    await pipeline(body, createWriteStream(tmp))

    let info: ModInfo
    try {
      info = await readModInfo(tmp)
    } catch (err) {
      throw new ModError(err instanceof TmodError ? err.message : tr('Unreadable .tmod file'), 422)
    }
    if (!MOD_VERSION.test(info.version)) throw new ModError(tr('Invalid mod version: "{version}"', { version: info.version }), 422)

    return await withServerLock(server, async () => {
      const installed = (await listMods(server)).mods.find((m) => m.name === info.name)
      if (installed?.version === info.version) {
        throw new ModError(tr('Version {version} of {mod} is the installed one: it is already available', { version: info.version ?? '?', mod: info.displayName ?? info.name }), 409)
      }
      await moveToArchive(server, tmp, info)
      const { size, mtimeMs } = await stat(versionPath(server, info.name, info.version))
      return { name: info.name, version: info.version, tmlVersion: info.tmlVersion, size, archivedAt: new Date(mtimeMs).toISOString() }
    })
  } finally {
    await rm(tmp, { force: true })
  }
}

/** Elimina definitivamente una versione dall'archivio. Da chiamare dentro withServerLock. */
export async function deleteArchived(server: ServerDefinition, name: string, version: string) {
  if (!(await hasArchivedVersion(server, name, version))) throw new ModError(tr('Version {version} of "{mod}" is not in the archive', { version, mod: name }), 404)
  await unlink(versionPath(server, name, version))
  infoCache.delete(versionPath(server, name, version))
  await rmdir(modDir(server, name)).catch(() => undefined)
}

/**
 * Installa una versione archiviata al posto di quella attuale (che entra nell'archivio).
 * La mod resta abilitata se lo era. Da chiamare dentro withServerLock.
 */
export async function useArchivedVersion(server: ServerDefinition, name: string, version: string): Promise<UploadResult> {
  if (!(await hasArchivedVersion(server, name, version))) throw new ModError(tr('Version {version} of "{mod}" is not in the archive', { version, mod: name }), 404)
  const source = versionPath(server, name, version)
  const info = await readModInfo(source)
  // Fuori dalla cartella dell'archivio prima di installare: installModFile vi rimette la versione attuale
  await mkdir(tmpDir(), { recursive: true })
  const staged = join(tmpDir(), `archive-use-${randomBytes(8).toString('hex')}.tmod`)
  await moveFile(source, staged)
  infoCache.delete(source)
  try {
    return await installModFile(server, staged, info, false)
  } catch (err) {
    // Installazione fallita: la versione torna nell'archivio
    await moveToArchive(server, staged, info).catch(() => undefined)
    throw err
  } finally {
    await rm(staged, { force: true })
    await rmdir(modDir(server, name)).catch(() => undefined)
  }
}

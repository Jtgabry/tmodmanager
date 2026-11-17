import { randomBytes } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { archivedVersionPath } from './archive.js'
import { findModpack } from './modpacks.js'
import { dependencyClosure, listMods, ModError, modsDir, tmpDir } from './mods.js'
import type { ServerDefinition } from './registry.js'
import { writeZip, type ZipEntry } from './zip.js'

/**
 * Esportazione di un modpack come cartella di tModLoader compressa in .zip:
 *
 *   <Nome del pack>/
 *   ├── Mods/        i .tmod del pack (alle versioni bloccate) e delle loro dipendenze, + enabled.json
 *   └── ModConfigs/  le configurazioni di quelle mod (<NomeMod>_<Config>.json)
 *
 * È lo stesso formato dei pack in Mods/ModPacks/ di tModLoader: si può importare lì o in un altro pannello.
 */

/** Nome valido come cartella (e file) su Windows, macOS e Linux. */
export function packFolderName(name: string) {
  const clean = name
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
  return clean || 'Modpack'
}

export type PackExport = { path: string; filename: string; size: number; cleanup: () => Promise<void> }

export async function exportModpackZip(server: ServerDefinition, id: string): Promise<PackExport> {
  const pack = await findModpack(server, id)
  if (!pack.mods.length) throw new ModError('Il modpack è vuoto: non c\'è niente da esportare', 422)
  const { mods } = await listMods(server)
  const installed = new Map(mods.map((m) => [m.name, m]))
  const graph = new Map(mods.map((m) => [m.name, m.dependencies]))
  const folder = packFolderName(pack.name)

  // Per ogni mod: la versione bloccata (installata o dall'archivio), altrimenti quella installata
  const entries: ZipEntry[] = []
  const included: string[] = []
  const missing: string[] = []
  for (const name of [...dependencyClosure(graph, pack.mods)].sort()) {
    const mod = installed.get(name)
    const pinned = pack.versions[name]
    let file: string | null = null
    if (mod && !mod.error && (!pinned || mod.version === pinned)) file = join(modsDir(server), mod.file)
    else if (pinned) file = await archivedVersionPath(server, name, pinned)
    if (!file) {
      missing.push(name)
      continue
    }
    entries.push({ name: `${folder}/Mods/${name}.tmod`, path: file, store: true })
    included.push(name)
  }
  if (!included.length) throw new ModError(`Nessuna mod del pack è disponibile sul server: ${missing.join(', ')}`, 422)

  // Configurazioni: in ModConfigs/ ogni file è <NomeMod>_<NomeConfig>.json
  const configsDir = join(server.saveDir, 'ModConfigs')
  const configs = await readdir(configsDir).catch(() => [] as string[])
  for (const file of configs.sort()) {
    if (!included.some((name) => file.startsWith(`${name}_`)) || !file.endsWith('.json')) continue
    const path = join(configsDir, file)
    if ((await stat(path)).isFile()) entries.push({ name: `${folder}/ModConfigs/${file}`, path })
  }

  const work = join(tmpDir(), `pack-export-${randomBytes(6).toString('hex')}`)
  await mkdir(work, { recursive: true })
  const cleanup = () => rm(work, { recursive: true, force: true })
  try {
    // enabled.json: le mod da abilitare caricando il pack in tModLoader
    const enabled = join(work, 'enabled.json')
    await writeFile(enabled, `${JSON.stringify(included, null, 2)}\n`)
    entries.splice(included.length, 0, { name: `${folder}/Mods/enabled.json`, path: enabled })

    const path = join(work, 'pack.zip')
    await writeZip(path, entries)
    return { path, filename: `${folder}.zip`, size: (await stat(path)).size, cleanup }
  } catch (err) {
    await cleanup()
    throw err
  }
}

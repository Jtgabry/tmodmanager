import { access, cp, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { config, projectRoot } from './config.js'
import { paths } from './paths.js'

/**
 * Spostamento una tantum dei dati dalla vecchia cartella agent/data alla cartella dati unica
 * (vedi paths.ts). Parte solo se la vecchia cartella esiste e la nuova non ha ancora un registry.
 * Alla fine la vecchia cartella viene rinominata in agent/data.migrated-<data> (dentro restano
 * solo cache e file temporanei: si può cancellare).
 *
 * I file vengono spostati con rename: un server acceso continua a scrivere il log della console
 * nello stesso file, che ora sta nel nuovo percorso.
 */
const defaultLegacyDir = resolve(projectRoot, 'agent', 'data')

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

async function move(from: string, to: string) {
  if (!(await exists(from))) return false
  await mkdir(dirname(to), { recursive: true })
  try {
    await rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await cp(from, to, { recursive: true, preserveTimestamps: true })
    await rm(from, { recursive: true, force: true })
  }
  return true
}

/** Sposta il contenuto di una cartella dentro un'altra (le voci già presenti nella destinazione restano dove sono). */
async function moveChildren(from: string, to: string) {
  let names: string[]
  try {
    names = await readdir(from)
  } catch {
    return 0
  }
  let moved = 0
  for (const name of names) {
    if (await exists(join(to, name))) continue
    if (await move(join(from, name), join(to, name))) moved++
  }
  return moved
}

export function migrateLegacyData(log: (message: string) => void): Promise<void> {
  return migrateLegacyDataFrom(defaultLegacyDir, log)
}

export async function migrateLegacyDataFrom(legacyDir: string, log: (message: string) => void): Promise<void> {
  if (resolve(config.dataDir) === resolve(legacyDir)) return
  if (!(await exists(join(legacyDir, 'servers.json')))) return
  if (await exists(paths.registry())) {
    log(`Migrazione dei dati: ${legacyDir} esiste ancora ma ${paths.registry()} c'è già; la vecchia cartella viene ignorata`)
    return
  }

  log(`Migrazione dei dati da ${legacyDir} a ${config.dataDir}…`)
  await mkdir(config.dataDir, { recursive: true })
  for (const file of ['workshop.json', 'pending-enable.json']) await move(join(legacyDir, file), join(config.dataDir, file))

  // Dati per server: si guardano tutte le sottocartelle, anche di server non più nel registry
  const ids = new Set<string>()
  for (const sub of ['trash', 'archive']) for (const id of await readdir(join(legacyDir, sub)).catch(() => [] as string[])) ids.add(id)
  for (const name of await readdir(join(legacyDir, 'modpacks')).catch(() => [] as string[])) if (name.endsWith('.json')) ids.add(name.slice(0, -5))
  for (const name of await readdir(join(legacyDir, 'state')).catch(() => [] as string[])) if (name.endsWith('.mods.json')) ids.add(name.slice(0, -10))
  for (const name of await readdir(join(legacyDir, 'logs')).catch(() => [] as string[])) {
    const match = name.match(/^(.+?)\.(log|log\.1|session)$/)
    if (match) ids.add(match[1])
  }

  for (const id of ids) {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) continue
    await move(join(legacyDir, 'modpacks', `${id}.json`), paths.modpacks(id))
    await move(join(legacyDir, 'state', `${id}.mods.json`), paths.modsState(id))
    await move(join(legacyDir, 'logs', `${id}.log`), join(paths.serverLogs(id), 'console.log'))
    await move(join(legacyDir, 'logs', `${id}.log.1`), join(paths.serverLogs(id), 'console.log.1'))
    await move(join(legacyDir, 'logs', `${id}.session`), join(paths.serverLogs(id), 'console.session'))
    await moveChildren(join(legacyDir, 'trash', id), paths.trash(id))
    await moveChildren(join(legacyDir, 'archive', id), paths.archive(id))
  }

  // Il registry per ultimo: se qualcosa sopra fallisce, al prossimo avvio la migrazione riparte
  await move(join(legacyDir, 'servers.json'), paths.registry())
  const done = `${legacyDir}.migrated-${new Date().toISOString().slice(0, 10)}`
  await rename(legacyDir, done)
  log(`Migrazione completata (${ids.size} server). Resti della vecchia cartella (cache, temporanei): ${done}`)
}

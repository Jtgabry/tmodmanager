import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { config } from './config.js'
import { paths } from './paths.js'

/**
 * Definizione di un server tModLoader.
 * Il registry (data/servers.json) è la fonte di verità: Laravel lo legge tramite l'agent.
 */
export const ServerDefinition = z
  .object({
    /** Identificativo usato negli URL: minuscole, numeri e trattini. */
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
    name: z.string().min(1).max(64),
    /** Cartella di installazione di tModLoader (contiene start-tModLoaderServer.sh). */
    installDir: z.string().refine(isAbsolute, 'deve essere un percorso assoluto'),
    /** Passato come -tmlsavedirectory: contiene Mods/, ModConfigs/, Worlds/… Identifica univocamente il server. */
    saveDir: z.string().refine(isAbsolute, 'deve essere un percorso assoluto'),
    /** serverconfig.txt, relativo a installDir oppure assoluto. */
    configFile: z.string().min(1).default('serverconfig.txt'),
    /** Nome della sessione screen; default "tml-<id>". */
    screenSession: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
    /** Argomenti extra per start-tModLoaderServer.sh. */
    launchArgs: z.array(z.string()).default(['-nosteam']),
  })
  .transform((s) => ({
    ...s,
    screenSession: s.screenSession ?? `tml-${s.id}`,
    configPath: isAbsolute(s.configFile) ? s.configFile : join(s.installDir, s.configFile),
  }))

export type ServerDefinition = z.output<typeof ServerDefinition>

const RegistryFile = z.object({ servers: z.array(ServerDefinition) }).refine(
  (r) => new Set(r.servers.map((s) => s.id)).size === r.servers.length,
  'id dei server duplicati',
)

export const registryPath = paths.registry

/** Legge il registry a ogni chiamata: è piccolo, e così le modifiche a mano valgono subito. */
export async function loadServers(): Promise<ServerDefinition[]> {
  let raw: string
  try {
    raw = await readFile(registryPath(), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return RegistryFile.parse(JSON.parse(raw)).servers
}

export async function findServer(id: string): Promise<ServerDefinition | undefined> {
  return (await loadServers()).find((s) => s.id === id)
}

// --- Modifica del registry (creazione/modifica/rimozione dei server dal pannello) ----------------

export type RawServer = z.input<typeof ServerDefinition>
let registryLock: Promise<unknown> = Promise.resolve()

/** Legge, modifica e riscrive servers.json in modo atomico; le modifiche non si sovrappongono. */
export function updateRegistry<T>(mutate: (servers: RawServer[]) => Promise<{ servers: RawServer[]; result: T }>): Promise<T> {
  const task = registryLock.then(async () => {
    let raw: { servers: RawServer[] } = { servers: [] }
    try {
      raw = JSON.parse(await readFile(registryPath(), 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    const { servers, result } = await mutate(raw.servers ?? [])
    RegistryFile.parse({ servers }) // validazione prima di scrivere
    await mkdir(config.dataDir, { recursive: true })
    const tmp = `${registryPath()}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, `${JSON.stringify({ servers }, null, 2)}\n`)
    await rename(tmp, registryPath())
    return result
  })
  registryLock = task.catch(() => undefined)
  return task
}

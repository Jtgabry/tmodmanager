import { randomBytes } from 'node:crypto'
import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { z } from 'zod'
import { config } from './config.js'
import type { ServerManager } from './manager.js'
import { paths } from './paths.js'
import { socketsOnPort } from './procfs.js'
import { loadServers, type RawServer, ServerDefinition, updateRegistry } from './registry.js'
import { applyServerConfig, ConfigChanges, readConfigValues, readServerConfig } from './serverConfig.js'
import { findInstallation, type Installation, installationId, type Job, listInstallations, listReleases, serverWorldRelease, startJob } from './tml.js'
import { gameLabel } from './games.js'
import { moveToTrash } from './trash.js'

/** Creazione, impostazioni e rimozione dei server (solo admin, lato Laravel). */

export class ServerAdminError extends Error {
  constructor(
    message: string,
    public readonly status: 404 | 409 | 422 = 422,
    public readonly field: string | null = null,
  ) {
    super(message)
  }
}

const SERVER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const WORLD_NAME = /^[A-Za-z0-9 _'-]{1,40}$/
/** Valori di serverconfig: una riga sola, niente caratteri di controllo. */
const configValue = (max: number) => z.string().max(max).regex(/^[^\r\n\0]*$/, 'non può contenere a capo')

const Settings = z.object({
  name: z.string().trim().min(1).max(64),
  port: z.number().int().min(1024).max(65535),
  maxPlayers: z.number().int().min(1).max(255),
  /** Stringa vuota = nessuna password. */
  password: configValue(64),
  motd: configValue(200),
})

export const CreateServerInput = Settings.extend({
  id: z.string().regex(SERVER_ID, 'solo minuscole, numeri e trattini (max 32)'),
  installDir: z.string().min(1),
  world: z.object({
    name: z.string().trim().regex(WORLD_NAME, 'lettere, numeri, spazi, _ - \' (max 40)'),
    /** 1 piccolo, 2 medio, 3 grande. */
    size: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    /** 0 classic, 1 expert, 2 master, 3 journey. */
    difficulty: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    seed: configValue(64).default(''),
  }),
  copyModsFrom: z.string().regex(SERVER_ID).nullable().default(null),
  launchArgs: z.array(z.string().max(200)).max(20).default(['-nosteam']),
})
export type CreateServerInput = z.infer<typeof CreateServerInput>

export const UpdateServerInput = Settings.partial().extend({
  launchArgs: z.array(z.string().max(200)).max(20).optional(),
  /** Cambio di versione: un'altra installazione (anche dell'altro gioco). Il server deve essere spento. */
  installDir: z.string().min(1).optional(),
  /** Altre chiavi di serverconfig.txt (vedi ConfigValues); null toglie la chiave. */
  config: ConfigChanges.optional(),
})

export type InstallationChoice = Pick<Installation, 'path' | 'kind' | 'version' | 'gameVersion' | 'worldRelease' | 'managed' | 'installed'> & {
  /** Installazione in corso (es. avviata dalla creazione di un server). */
  installing: boolean
}

/**
 * Installazioni utilizzabili da un server: quelle installate più le due del pannello anche se non ancora
 * installate (creando un server su una di queste viene installata da sola). Prima Terraria, poi tModLoader.
 */
export async function knownInstallations(): Promise<InstallationChoice[]> {
  return (await listInstallations())
    .filter((i) => i.installed || i.managed)
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'terraria' ? -1 : 1))
    .map(({ path, kind, version, gameVersion, worldRelease, managed, installed, job }) => ({
      path,
      kind,
      version,
      gameVersion,
      worldRelease,
      managed,
      installed,
      installing: job !== null && job.phase !== 'done' && job.phase !== 'error',
    }))
}

/** `allowMissing`: va bene anche un'installazione del pannello non ancora installata (creazione). */
async function findChoice(installDir: string, allowMissing = false): Promise<InstallationChoice> {
  const found = (await knownInstallations()).find((i) => i.path === installDir)
  if (!found || (!found.installed && !(allowMissing && found.managed))) {
    throw new ServerAdminError('Installazione sconosciuta o non ancora installata', 422, 'installDir')
  }
  return found
}

/**
 * Installa l'ultima versione stabile di un'installazione del pannello che manca. Non fa fallire la
 * creazione del server: se non riesce si restituisce il motivo (si riprova da Installazioni).
 */
async function installLatest(choice: InstallationChoice, manager: ServerManager): Promise<{ job: Job | null; error: string | null }> {
  if (choice.installing) return { job: null, error: null }
  try {
    const release = (await listReleases(choice.kind)).find((r) => !r.prerelease)
    if (!release) throw new Error(`nessuna versione stabile di ${gameLabel(choice.kind)} trovata`)
    const job = await startJob(await findInstallation(installationId(choice.path)), { version: release.version }, false, manager)
    return { job, error: null }
  } catch (err) {
    return { job: null, error: (err as Error).message }
  }
}

async function assertPortFree(port: number, exceptId: string | null) {
  const range = config.gamePorts
  if (range && (port < range.min || port > range.max)) {
    throw new ServerAdminError(`La porta deve essere tra ${range.min} e ${range.max} (porte pubblicate per i server)`, 422, 'port')
  }
  for (const s of await loadServers()) {
    if (s.id === exceptId) continue
    if ((await readServerConfig(s.configPath)).port === port) {
      throw new ServerAdminError(`La porta ${port} è già usata dal server "${s.name}"`, 409, 'port')
    }
  }
  if (exceptId === null && (await socketsOnPort(port)).listening) {
    throw new ServerAdminError(`La porta ${port} è già in uso da un altro programma`, 409, 'port')
  }
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

/** Prima porta libera dalla 7777 in su (suggerimento per il form). */
export async function suggestPort(): Promise<number> {
  const used = new Set<number>()
  for (const s of await loadServers()) used.add((await readServerConfig(s.configPath)).port)
  const { min, max } = config.gamePorts ?? { min: 7777, max: 7876 }
  for (let port = min; port <= max; port++) {
    if (!used.has(port) && !(await socketsOnPort(port)).listening) return port
  }
  return min
}

/**
 * Crea il server. Se il gioco scelto non è ancora installato (installazione del pannello), dopo la creazione
 * parte l'installazione dell'ultima versione: il server si può accendere quando è finita.
 * `manager` serve solo per quell'installazione.
 */
export async function createServer(input: CreateServerInput, manager?: ServerManager) {
  const servers = await loadServers()
  if (servers.some((s) => s.id === input.id)) throw new ServerAdminError(`Esiste già un server con id "${input.id}"`, 409, 'id')
  const installation = await findChoice(input.installDir, manager !== undefined)
  await assertPortFree(input.port, null)
  const source = input.copyModsFrom ? servers.find((s) => s.id === input.copyModsFrom) : null
  if (input.copyModsFrom && !source) throw new ServerAdminError('Server da cui copiare le mod non trovato', 422, 'copyModsFrom')

  const serverDir = paths.server(input.id)
  const saveDir = paths.serverSave(input.id)
  if (await exists(serverDir)) {
    throw new ServerAdminError(`La cartella ${serverDir} esiste già: scegli un altro id o spostala`, 409, 'id')
  }

  await mkdir(join(saveDir, 'Worlds'), { recursive: true })
  await mkdir(join(saveDir, 'Mods'), { recursive: true })
  try {
    if (source) {
      // Le mod (e le loro configurazioni) dell'altro server; i suoi ModPacks no
      await cp(join(source.saveDir, 'Mods'), join(saveDir, 'Mods'), {
        recursive: true,
        filter: (src) => !src.startsWith(join(source.saveDir, 'Mods', 'ModPacks')),
      })
      if (await exists(join(source.saveDir, 'ModConfigs'))) {
        await cp(join(source.saveDir, 'ModConfigs'), join(saveDir, 'ModConfigs'), { recursive: true })
      }
    }

    const configPath = paths.serverConfig(input.id)
    const header = [
      `# Creato da tModManager il ${new Date().toISOString()}`,
      '# Le chiavi sono quelle di serverconfig.txt di Terraria. Al primo avvio il mondo viene generato',
      '# (autocreate): la generazione può richiedere qualche minuto.',
      '',
    ].join('\n')
    const text = applyServerConfig(header, {
      world: join(saveDir, 'Worlds', `${input.world.name}.wld`),
      autocreate: String(input.world.size),
      worldname: input.world.name,
      difficulty: String(input.world.difficulty),
      seed: input.world.seed || null,
      port: String(input.port),
      maxplayers: String(input.maxPlayers),
      password: input.password || null,
      motd: input.motd || null,
    })
    await writeFile(configPath, text)

    const raw: RawServer = {
      id: input.id,
      name: input.name,
      game: installation.kind,
      installDir: input.installDir,
      saveDir,
      configFile: configPath,
      launchArgs: input.launchArgs,
    }
    ServerDefinition.parse(raw)
    await updateRegistry(async (list) => {
      if (list.some((s) => s.id === input.id)) throw new ServerAdminError(`Esiste già un server con id "${input.id}"`, 409, 'id')
      return { servers: [...list, raw], result: undefined }
    })
    const install = !installation.installed && manager ? await installLatest(installation, manager) : null
    return {
      id: input.id,
      saveDir: serverDir,
      configPath,
      /** Installazione partita per questo server (null se il gioco era già installato). */
      install: install && { game: installation.kind, version: install.job?.toVersion ?? null, error: install.error },
    }
  } catch (err) {
    // Creazione fallita: niente cartelle a metà
    await rm(serverDir, { recursive: true, force: true })
    throw err
  }
}

export async function serverSettings(id: string) {
  const server = (await loadServers()).find((s) => s.id === id)
  if (!server) throw new ServerAdminError('Server non trovato', 404)
  const text = await readFile(server.configPath, 'utf8').catch(() => '')
  const settings = await readServerConfig(server.configPath)
  return {
    id: server.id,
    name: server.name,
    game: server.game,
    installDir: server.installDir,
    /** Versione del mondo attuale (null se non ancora generato). */
    worldRelease: await serverWorldRelease(server),
    saveDir: server.saveDir,
    configPath: server.configPath,
    launchArgs: server.launchArgs,
    port: settings.port,
    maxPlayers: settings.maxPlayers,
    hasPassword: settings.hasPassword,
    motd: settings.motd ?? '',
    world: settings.world,
    worldName: settings.worldName,
    /** Chiavi di serverconfig.txt modificabili presenti nel file (le assenti valgono il default di Terraria). */
    config: readConfigValues(text),
  }
}

/** Modifica nome/argomenti (registry) e porta/giocatori/password/motd (serverconfig.txt). Valgono al prossimo avvio. */
export async function updateServer(id: string, input: z.infer<typeof UpdateServerInput>, manager: ServerManager) {
  const server = (await loadServers()).find((s) => s.id === id)
  if (!server) throw new ServerAdminError('Server non trovato', 404)
  if (input.port !== undefined) await assertPortFree(input.port, id)

  // Cambio di versione (anche Terraria ↔ tModLoader): stesso mondo, nella stessa cartella Worlds/
  let switchTo: InstallationChoice | null = null
  if (input.installDir !== undefined && input.installDir !== server.installDir) {
    switchTo = await findChoice(input.installDir)
    const status = await manager.status(server)
    if (status.state !== 'stopped' || status.operation) {
      throw new ServerAdminError('Spegni il server prima di cambiare versione', 409, 'installDir')
    }
    if (switchTo.kind === 'tmodloader') await mkdir(join(server.saveDir, 'Mods'), { recursive: true })
  }

  const changes: Record<string, string | null> = {}
  for (const [key, value] of Object.entries(input.config ?? {})) if (value !== undefined) changes[key] = value
  if (input.port !== undefined) changes.port = String(input.port)
  if (input.maxPlayers !== undefined) changes.maxplayers = String(input.maxPlayers)
  if (input.password !== undefined) changes.password = input.password || null
  if (input.motd !== undefined) changes.motd = input.motd || null
  if (Object.keys(changes).length) {
    const current = await readFile(server.configPath, 'utf8').catch(() => '')
    const tmp = `${server.configPath}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, applyServerConfig(current, changes))
    await rename(tmp, server.configPath)
  }

  if (input.name !== undefined || input.launchArgs !== undefined || switchTo) {
    await updateRegistry(async (list) => ({
      servers: list.map((s) =>
        s.id === id
          ? {
              ...s,
              ...(input.name !== undefined && { name: input.name }),
              ...(input.launchArgs !== undefined && { launchArgs: input.launchArgs }),
              ...(switchTo && { game: switchTo.kind, installDir: switchTo.path }),
            }
          : s,
      ),
      result: undefined,
    }))
  }
  return serverSettings(id)
}

/** File di un mondo: il .wld più i dati di tModLoader (.twld) e i backup che Terraria tiene accanto. */
const WORLD_COMPANIONS = ['', '.bak', '.bak2']
const worldFiles = (world: string) => {
  const base = world.replace(/\.wld$/i, '')
  return WORLD_COMPANIONS.flatMap((suffix) => [`${base}.wld${suffix}`, `${base}.twld${suffix}`])
}

/**
 * Ricrea il mondo da capo: i file del mondo attuale vanno nel cestino (recuperabili), e al prossimo
 * avvio il server ne genera uno nuovo con nome, dimensione, difficoltà e seed del serverconfig.
 */
export async function recreateWorld(id: string, manager: ServerManager) {
  const server = (await loadServers()).find((s) => s.id === id)
  if (!server) throw new ServerAdminError('Server non trovato', 404)
  const status = await manager.status(server)
  if (status.state !== 'stopped' || status.operation) throw new ServerAdminError('Spegni il server prima di ricreare il mondo', 409)

  const { world } = await readServerConfig(server.configPath)
  if (!world) throw new ServerAdminError('Nel serverconfig non c\'è nessun mondo (chiave world)', 422)
  const inSave = !relative(server.saveDir, world).startsWith('..')
  const trashed: string[] = []
  for (const file of worldFiles(world)) {
    if (!(await exists(file))) continue
    await moveToTrash(server, file, {
      kind: 'file',
      name: basename(file),
      root: inSave ? 'save' : 'worlds',
      path: inSave ? relative(server.saveDir, file) : basename(file),
      modName: null,
      modVersion: null,
      reason: 'deleted',
    })
    trashed.push(basename(file))
  }

  // Senza autocreate il server non genererebbe il mondo mancante
  const text = await readFile(server.configPath, 'utf8')
  if (!/^\s*autocreate\s*=\s*[123]\s*$/im.test(text)) {
    const tmp = `${server.configPath}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, applyServerConfig(text, { autocreate: '2', worldname: basename(world).replace(/\.wld$/i, '') }))
    await rename(tmp, server.configPath)
  }
  await mkdir(dirname(world), { recursive: true })
  return { trashed }
}

/**
 * Toglie il server dal pannello. I suoi file (mondo, mod, modpack, archivio, cestino) restano in
 * data/servers/<id>/ (e nel saveDir, se è esterno); si tolgono solo log e stato.
 */
export async function removeServer(id: string, manager: ServerManager) {
  const server = (await loadServers()).find((s) => s.id === id)
  if (!server) throw new ServerAdminError('Server non trovato', 404)
  const status = await manager.status(server)
  if (status.state !== 'stopped' || status.operation) throw new ServerAdminError('Spegni il server prima di rimuoverlo', 409)

  await updateRegistry(async (list) => ({ servers: list.filter((s) => s.id !== id), result: undefined }))
  await Promise.all([paths.serverLogs(id), paths.modsState(id)].map((p) => rm(p, { recursive: true, force: true })))
  return { saveDir: server.saveDir.startsWith(paths.server(id)) ? paths.server(id) : server.saveDir }
}

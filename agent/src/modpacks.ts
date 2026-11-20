import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { isModAddon } from './addons.js'
import { hasArchivedVersion, MOD_VERSION, useArchivedVersion } from './archive.js'
import { paths } from './paths.js'
import { dependencyClosure, disableMods, enableMods, listMods, MOD_NAME, ModError, readEnabled } from './mods.js'
import type { ServerDefinition } from './registry.js'
import { tr } from './i18n.js'

/**
 * Modpack = insieme di mod con un nome, attivabile o disattivabile.
 * Le mod che stanno in almeno un pack sono "gestite dai pack": restano abilitate solo se servono
 * a un pack attivo o (come dipendenza) a una mod abilitata a mano fuori da qualsiasi pack.
 *
 * Una mod del pack può avere una versione bloccata (`versions`): attivando il pack, se è installata
 * un'altra versione, si passa a quella bloccata prendendola dall'archivio delle versioni.
 * Senza versione bloccata la mod "segue gli aggiornamenti": va bene quella installata.
 */
const Modpack = z.object({
  id: z.string().regex(/^[a-z0-9]{8}$/),
  name: z.string().trim().min(1).max(64),
  description: z.string().max(500).default(''),
  mods: z.array(z.string().regex(MOD_NAME)).max(500),
  /** Mod → versione bloccata. */
  versions: z.record(z.string().regex(MOD_NAME), z.string().regex(MOD_VERSION)).default({}),
  active: z.boolean().default(false),
  createdAt: z.string().optional(),
})
type Modpack = z.infer<typeof Modpack>

export const ModpackInput = Modpack.pick({ name: true, description: true, mods: true, versions: true })

/** Solo le versioni bloccate di mod che sono nel pack. */
const cleanVersions = (mods: string[], versions: Record<string, string>) =>
  Object.fromEntries(Object.entries(versions).filter(([name]) => mods.includes(name)))
export type ModpackInput = z.infer<typeof ModpackInput>

const FileSchema = z.object({ packs: z.array(Modpack) })
const packsPath = (server: ServerDefinition) => paths.modpacks(server.id)

async function load(server: ServerDefinition): Promise<Modpack[]> {
  try {
    return FileSchema.parse(JSON.parse(await readFile(packsPath(server), 'utf8'))).packs
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

async function save(server: ServerDefinition, packs: Modpack[]) {
  const path = packsPath(server)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, `${JSON.stringify({ packs }, null, 2)}\n`)
  await rename(tmp, path)
}

export type ModpackView = Modpack & {
  /** enabled = attivo, tutte le mod abilitate e alle versioni bloccate; partial = attivo ma non del tutto. */
  state: 'enabled' | 'partial' | 'disabled'
  /** Mod del pack non installate (e senza una versione bloccata nell'archivio da cui installarle). */
  missing: string[]
  /** Mod con una versione bloccata che non c'è più (né installata né nell'archivio). */
  unavailable: string[]
  /** Mod la cui versione bloccata è nell'archivio, diversa da quella installata: l'attivazione la cambia. */
  toSwitch: { name: string; from: string | null; to: string }[]
  /** Add-on di tModManager nel pack (es. LiveMap): restano sul server, non vengono mai esportati. */
  addons: string[]
}

/** Cosa manca o va cambiato per avere il pack com'è definito. */
async function resolvePack(server: ServerDefinition, pack: Modpack, installed: Map<string, string | null>) {
  const missing: string[] = []
  const unavailable: string[] = []
  const toSwitch: ModpackView['toSwitch'] = []
  for (const name of pack.mods) {
    const pinned = pack.versions[name]
    const current = installed.has(name) ? installed.get(name)! : undefined
    if (!pinned || current === pinned) {
      if (current === undefined) missing.push(name)
      continue
    }
    if (await hasArchivedVersion(server, name, pinned)) toSwitch.push({ name, from: current ?? null, to: pinned })
    else if (current === undefined) missing.push(name)
    else unavailable.push(name)
  }
  return { missing, unavailable, toSwitch }
}

export async function listModpacks(server: ServerDefinition): Promise<ModpackView[]> {
  const [packs, enabled, { mods }] = await Promise.all([load(server), readEnabled(server), listMods(server)])
  const installed = new Map(mods.map((m) => [m.name, m.version]))
  const on = new Set(enabled)
  return Promise.all(
    packs.map(async (pack) => {
      const resolved = await resolvePack(server, pack, installed)
      const complete = pack.mods.every((m) => on.has(m)) && !resolved.toSwitch.length && !resolved.unavailable.length
      return { ...pack, state: !pack.active ? 'disabled' : complete ? 'enabled' : 'partial', ...resolved, addons: pack.mods.filter(isModAddon) } satisfies ModpackView
    }),
  )
}

/** Nomi dei pack che bloccano quella versione della mod (per non toglierla dall'archivio sotto i loro piedi). */
export async function packsPinning(server: ServerDefinition, name: string, version: string): Promise<string[]> {
  return (await load(server)).filter((p) => p.mods.includes(name) && p.versions[name] === version).map((p) => p.name)
}

export async function findModpack(server: ServerDefinition, id: string): Promise<Modpack> {
  const pack = (await load(server)).find((p) => p.id === id)
  if (!pack) throw new ModError(tr('Modpack not found'), 404)
  return pack
}

export async function createModpack(server: ServerDefinition, input: ModpackInput) {
  const packs = await load(server)
  if (packs.some((p) => p.name.toLowerCase() === input.name.toLowerCase())) {
    throw new ModError(tr('A modpack named "{name}" already exists', { name: input.name }), 422)
  }
  const mods = [...new Set(input.mods)]
  // Un pack creato con mod già tutte abilitate nasce attivo: altrimenti la prossima
  // disattivazione di un altro pack le spegnerebbe a sorpresa
  const enabled = new Set(await readEnabled(server))
  const active = mods.length > 0 && mods.every((m) => enabled.has(m))
  const pack: Modpack = {
    id: randomBytes(4).toString('hex'),
    ...input,
    mods,
    versions: cleanVersions(mods, input.versions),
    active,
    createdAt: new Date().toISOString(),
  }
  await save(server, [...packs, pack])
  return pack
}

export async function updateModpack(server: ServerDefinition, id: string, input: ModpackInput) {
  const packs = await load(server)
  const index = packs.findIndex((p) => p.id === id)
  if (index < 0) throw new ModError(tr('Modpack not found'), 404)
  if (packs.some((p) => p.id !== id && p.name.toLowerCase() === input.name.toLowerCase())) {
    throw new ModError(tr('A modpack named "{name}" already exists', { name: input.name }), 422)
  }
  const mods = [...new Set(input.mods)]
  packs[index] = { ...packs[index], ...input, mods, versions: cleanVersions(mods, input.versions) }
  await save(server, packs)
  return packs[index]
}

export async function deleteModpack(server: ServerDefinition, id: string) {
  const packs = await load(server)
  if (!packs.some((p) => p.id === id)) throw new ModError(tr('Modpack not found'), 404)
  await save(server, packs.filter((p) => p.id !== id))
}

async function setActive(server: ServerDefinition, id: string, active: boolean): Promise<Modpack[]> {
  const packs = await load(server)
  const pack = packs.find((p) => p.id === id)
  if (!pack) throw new ModError(tr('Modpack not found'), 404)
  pack.active = active
  await save(server, packs)
  return packs
}

/**
 * Porta le mod alle versioni bloccate (dall'archivio), abilita tutte le mod del pack (con le
 * dipendenze) e lo segna come attivo. Da chiamare dentro withServerLock.
 *
 * Con `exclusive` resta abilitato SOLO il pack: tutte le altre mod vengono disabilitate e gli
 * altri pack segnati come disattivi.
 */
export async function enableModpack(server: ServerDefinition, id: string, { exclusive = false } = {}) {
  const pack = await findModpack(server, id)
  const { mods } = await listMods(server)
  const { missing, unavailable, toSwitch } = await resolvePack(server, pack, new Map(mods.map((m) => [m.name, m.version])))
  // Prima i controlli: se manca qualcosa il pack e le mod restano come sono
  if (missing.length) throw new ModError(tr('Pack mods not installed: {mods}', { mods: missing.join(', ') }), 422, { missing })
  if (unavailable.length) {
    const list = unavailable.map((n) => `${n} v${pack.versions[n]}`).join(', ')
    throw new ModError(tr('Locked versions no longer available in the archive: {mods}. Choose them again in the pack.', { mods: list }), 422, { unavailable })
  }
  const graph = new Map(mods.map((m) => [m.name, m.dependencies]))
  const absent = [...dependencyClosure(graph, pack.mods)].filter((n) => !graph.has(n) && !toSwitch.some((s) => s.name === n))
  if (absent.length) throw new ModError(tr('Missing dependencies: {mods}. Install them before activating the pack.', { mods: absent.join(', ') }), 422, { missing: absent })

  for (const change of toSwitch) await useArchivedVersion(server, change.name, change.to)
  const enabled = await enableMods(server, pack.mods)

  let disabled: string[] = []
  let deactivated: string[] = []
  if (exclusive) {
    // Le mod del pack con tutte le dipendenze (ricalcolate: le versioni possono essere cambiate)
    const after = (await listMods(server)).mods
    const keep = dependencyClosure(new Map(after.map((m) => [m.name, m.dependencies])), pack.mods)
    const others = (await readEnabled(server)).filter((n) => !keep.has(n))
    // cascade: nessuna mod da tenere dipende da queste, quindi non ne trascina via nessuna
    if (others.length) disabled = await disableMods(server, others, true)
    const packs = await load(server)
    deactivated = packs.filter((p) => p.id !== id && p.active).map((p) => p.name)
    for (const p of packs) p.active = p.id === id
    await save(server, packs)
  } else {
    await setActive(server, id, true)
  }
  return { enabled, disabled, deactivated, switched: toSwitch }
}

/**
 * Disattiva il pack e ricalcola le mod gestite dai pack: restano abilitate solo quelle che servono
 * ai pack ancora attivi o alle mod abilitate a mano (con tutte le dipendenze).
 */
export async function disableModpack(server: ServerDefinition, id: string) {
  const packs = await setActive(server, id, false)
  const enabled = await readEnabled(server)
  const { mods } = await listMods(server)
  const graph = new Map(mods.map((m) => [m.name, m.dependencies]))

  const packMods = new Set(packs.flatMap((p) => p.mods))
  const loose = enabled.filter((m) => !packMods.has(m))
  const activeMods = packs.filter((p) => p.active).flatMap((p) => p.mods)
  const required = dependencyClosure(graph, [...loose, ...activeMods])

  const toDisable = enabled.filter((m) => packMods.has(m) && !required.has(m))
  const disabled = toDisable.length ? await disableMods(server, toDisable, true) : []
  const pack = packs.find((p) => p.id === id)
  const kept = (pack?.mods ?? []).filter((m) => enabled.includes(m) && !disabled.includes(m))
  return { disabled, kept }
}

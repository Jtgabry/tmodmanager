import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ADDONS, type Addon, addonPath } from './addons.js'
import { tshockPluginsDir } from './games.js'
import { ModError } from './mods.js'
import { paths } from './paths.js'
import type { ServerDefinition } from './registry.js'
import { move, moveToTrash, type TrashMeta } from './trash.js'

/**
 * Plugin dei server TShock, con tutte le versioni caricate.
 *
 *   data/servers/<id>/plugins/<Plugin>/<impronta>.dll   ogni versione caricata (la data del file = caricamento)
 *   data/servers/<id>/plugins/<Plugin>/state.json        { selected }: la versione scelta
 *   <save>/ServerPlugins/<Plugin>.dll                     copia della versione scelta, se il plugin è attivo
 *   <install>/ServerPlugins/                              plugin inclusi in TShock (solo lettura)
 *
 * TShock carica ogni .dll di ServerPlugins/: un plugin è attivo se lì c'è il suo file, disattivato se no.
 * Le versioni sono identificate dall'impronta del contenuto, così due build con lo stesso numero di
 * versione restano distinte e ricaricare lo stesso file non crea doppioni. Le .dll messe a mano in
 * ServerPlugins/ (dal tab File) entrano nell'archivio alla prima lettura dell'elenco.
 * Le modifiche valgono al riavvio del server: TShock non carica i plugin a caldo.
 */

export const PLUGIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,95}$/
export const PLUGIN_VERSION_ID = /^[0-9a-f]{16}$/
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

export const activePluginsDir = (server: ServerDefinition) => tshockPluginsDir(server.saveDir)
const bundledPluginsDir = (server: ServerDefinition) => join(server.installDir, 'ServerPlugins')
const storeRoot = (server: ServerDefinition) => join(paths.server(server.id), 'plugins')
const storeDir = (server: ServerDefinition, name: string) => join(storeRoot(server), name)
const versionPath = (server: ServerDefinition, name: string, id: string) => join(storeDir(server, name), `${id}.dll`)
const statePath = (server: ServerDefinition, name: string) => join(storeDir(server, name), 'state.json')

// --- Lettura delle .dll ----------------------------------------------------------------------------

export type AssemblyInfo = {
  /** Nome dell'assembly (InternalName della risorsa di versione, senza .dll); null se manca. */
  name: string | null
  /** plugin = contiene una classe TerrariaPlugin; library = assembly .NET senza plugin (una dipendenza). */
  kind: 'plugin' | 'library'
  title: string | null
  version: string | null
  author: string | null
  description: string | null
}

/**
 * Legge da un assembly .NET quello che serve all'elenco, senza eseguirlo:
 *  - è un .NET (PE con intestazione CLR)?
 *  - è un plugin (riferisce il tipo TerrariaPlugin)?
 *  - nome, titolo, versione, autore e descrizione dalla risorsa di versione (InternalName, FileDescription,
 *    ProductVersion, CompanyName, Comments: il .NET SDK ci copia nome dell'assembly, AssemblyTitle,
 *    InformationalVersion, Company e Description).
 * Nome, versione e autore che il plugin dichiara nel codice (proprietà di TerrariaPlugin) non sono
 * leggibili senza caricarlo.
 */
export function readAssemblyInfo(data: Buffer): AssemblyInfo {
  if (!isDotnetAssembly(data)) throw new ModError('Non è un assembly .NET: i plugin TShock sono .dll compilate per .NET', 422)

  const strings = versionStrings(data)
  const name = cleanName((strings.InternalName ?? strings.OriginalFilename ?? '').replace(/\.(dll|exe)$/i, ''))
  const company = strings.CompanyName ?? null
  const title = strings.FileDescription ?? strings.ProductName ?? null
  const version = (strings.ProductVersion ?? strings.FileVersion ?? '').replace(/\+.*$/, '') || null
  return {
    name,
    // Il nome del tipo base sta nell'heap #Strings (UTF-8, terminato da \0)
    kind: data.includes(Buffer.from('\0TerrariaPlugin\0', 'latin1')) ? 'plugin' : 'library',
    title,
    version,
    // Senza <Company> il SDK ci mette il nome dell'assembly: in quel caso non è un autore
    author: company && company !== title && company !== name ? company : null,
    description: strings.Comments ?? null,
  }
}

/** Nome utilizzabile come cartella e come file: caratteri strani → _, niente punti iniziali. */
function cleanName(raw: string): string | null {
  const name = raw.replace(/[^A-Za-z0-9_.+-]/g, '_').replace(/^[^A-Za-z0-9_]+/, '').slice(0, 96)
  return PLUGIN_NAME.test(name) ? name : null
}

function isDotnetAssembly(data: Buffer): boolean {
  if (data.length < 0x40 || data.toString('latin1', 0, 2) !== 'MZ') return false
  const pe = data.readUInt32LE(0x3c)
  if (pe + 26 > data.length || data.toString('latin1', pe, pe + 4) !== 'PE\0\0') return false
  const optional = pe + 24
  const magic = data.readUInt16LE(optional)
  // PE32 (0x10b) o PE32+ (0x20b): cambia dove iniziano le data directory
  const [countAt, dirs] = magic === 0x10b ? [optional + 92, optional + 96] : magic === 0x20b ? [optional + 108, optional + 112] : [0, 0]
  if (!dirs || dirs + 15 * 8 > data.length) return false
  if (data.readUInt32LE(countAt) <= 14) return false
  // Directory 14: intestazione CLR (solo gli assembly .NET la hanno)
  return data.readUInt32LE(dirs + 14 * 8) !== 0 && data.readUInt32LE(dirs + 14 * 8 + 4) !== 0
}

const VERSION_KEYS = ['FileDescription', 'ProductName', 'ProductVersion', 'FileVersion', 'CompanyName', 'Comments', 'InternalName', 'OriginalFilename'] as const
type VersionStrings = Partial<Record<(typeof VERSION_KEYS)[number], string>>

/**
 * Stringhe della risorsa VS_VERSIONINFO. Ogni voce è { wLength, wValueLength, wType, chiave UTF-16 \0,
 * allineamento a 4 byte, valore UTF-16 }; si cercano le chiavi dopo "StringFileInfo".
 */
function versionStrings(data: Buffer): VersionStrings {
  const result: VersionStrings = {}
  const start = data.lastIndexOf(Buffer.from('StringFileInfo\0', 'utf16le'))
  if (start < 0) return result
  for (const key of VERSION_KEYS) {
    const at = data.indexOf(Buffer.from(`${key}\0`, 'utf16le'), start)
    if (at < start + 6) continue
    const header = at - 6
    const valueLength = data.readUInt16LE(header + 2) // in caratteri, \0 compreso
    if (valueLength <= 1) continue
    const keyEnd = at + (key.length + 1) * 2
    const valueStart = header + Math.ceil((keyEnd - header) / 4) * 4
    let value = ''
    for (let i = valueStart; i + 1 < data.length && value.length < Math.min(valueLength, 512); i += 2) {
      const code = data.readUInt16LE(i)
      if (code === 0) break
      value += String.fromCharCode(code)
    }
    value = value.trim()
    if (value) result[key] = value
  }
  return result
}

type FileInfo = { id: string; size: number; mtimeMs: number; info: AssemblyInfo | null; error: string | null }

/** Lettura di una .dll in cache finché non cambiano dimensione e data. */
const infoCache = new Map<string, { key: string; value: FileInfo }>()

async function fileInfo(path: string): Promise<FileInfo | null> {
  const s = await stat(path).catch(() => null)
  if (!s?.isFile()) return null
  const key = `${s.size}:${s.mtimeMs}`
  const hit = infoCache.get(path)
  if (hit?.key === key) return hit.value
  let value: FileInfo
  if (s.size > MAX_UPLOAD_BYTES) {
    value = { id: '', size: s.size, mtimeMs: s.mtimeMs, info: null, error: 'File troppo grande per essere letto' }
  } else {
    const data = await readFile(path)
    const id = versionId(data)
    try {
      value = { id, size: s.size, mtimeMs: s.mtimeMs, info: readAssemblyInfo(data), error: null }
    } catch (err) {
      value = { id, size: s.size, mtimeMs: s.mtimeMs, info: null, error: err instanceof Error ? err.message : String(err) }
    }
  }
  infoCache.set(path, { key, value })
  return value
}

const versionId = (data: Buffer) => createHash('sha256').update(data).digest('hex').slice(0, 16)

const listDlls = async (dir: string) => {
  try {
    return (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.dll'))
  } catch {
    return []
  }
}

// --- Elenco ----------------------------------------------------------------------------------------

export type PluginVersion = {
  id: string
  version: string | null
  size: number
  /** Quando è stata caricata (o trovata in ServerPlugins/). */
  uploadedAt: string
}

export type PluginEntry = {
  name: string
  kind: 'plugin' | 'library' | null
  title: string | null
  author: string | null
  description: string | null
  /** C'è un suo file in ServerPlugins/: TShock lo carica. */
  enabled: boolean
  /** Versione scelta: quella in ServerPlugins/ se attivo, quella che verrà attivata altrimenti. */
  selected: string | null
  /** Tutte le versioni salvate, dalla più recente. */
  versions: PluginVersion[]
  /** File in ServerPlugins/ che non è un assembly .NET leggibile (non ha versioni). */
  error: string | null
  /** Nome del file in ServerPlugins/ (se attivo). */
  file: string | null
  /**
   * Add-on di tModManager: arriva con il pannello (sempre in elenco, disattivato finché non lo si attiva) e si
   * aggiorna con lui. Ha una sola versione, quella distribuita; non si carica né si elimina da qui.
   */
  addon: boolean
}

export type BundledPlugin = Pick<PluginEntry, 'kind' | 'title' | 'author' | 'description'> & { file: string; version: string | null; size: number }

export type PluginList = { plugins: PluginEntry[]; bundled: BundledPlugin[] }

type ActiveFile = { file: string; path: string; info: FileInfo }

/** File in ServerPlugins/, per nome del plugin. */
async function activeFiles(server: ServerDefinition): Promise<{ byName: Map<string, ActiveFile>; broken: ActiveFile[] }> {
  const byName = new Map<string, ActiveFile>()
  const broken: ActiveFile[] = []
  for (const file of await listDlls(activePluginsDir(server))) {
    const path = join(activePluginsDir(server), file)
    const info = await fileInfo(path)
    if (!info) continue
    const name = info.info ? (info.info.name ?? cleanName(file.slice(0, -4))) : null
    if (!name) broken.push({ file, path, info })
    else if (!byName.has(name) || file === `${name}.dll`) byName.set(name, { file, path, info })
  }
  return { byName, broken }
}

async function storedVersions(server: ServerDefinition, name: string): Promise<(PluginVersion & { info: AssemblyInfo })[]> {
  const versions = await Promise.all(
    (await listDlls(storeDir(server, name)))
      .filter((f) => PLUGIN_VERSION_ID.test(f.slice(0, -4)))
      .map(async (f) => {
        const found = await fileInfo(join(storeDir(server, name), f))
        if (!found?.info) return null
        return { id: f.slice(0, -4), version: found.info.version, size: found.size, uploadedAt: new Date(found.mtimeMs).toISOString(), info: found.info }
      }),
  )
  return versions.filter((v) => v !== null).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
}

async function readSelected(server: ServerDefinition, name: string): Promise<string | null> {
  try {
    const { selected } = JSON.parse(await readFile(statePath(server, name), 'utf8')) as { selected?: unknown }
    return typeof selected === 'string' && PLUGIN_VERSION_ID.test(selected) ? selected : null
  } catch {
    return null
  }
}

async function writeSelected(server: ServerDefinition, name: string, selected: string) {
  await mkdir(storeDir(server, name), { recursive: true })
  const tmp = `${statePath(server, name)}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, `${JSON.stringify({ selected }, null, 2)}\n`)
  await rename(tmp, statePath(server, name))
}

/** Salva una versione nell'archivio (copia); se c'è già, lascia quella. Restituisce il suo id. */
async function storeCopy(server: ServerDefinition, name: string, from: string, id: string, { moveSource = false } = {}) {
  const target = versionPath(server, name, id)
  if (await stat(target).catch(() => null)) return
  await mkdir(storeDir(server, name), { recursive: true })
  const staging = `${target}.${randomBytes(4).toString('hex')}.tmp`
  if (moveSource) await move(from, staging)
  else await copyFile(from, staging)
  const now = new Date()
  await utimes(staging, now, now)
  await rename(staging, target)
}

/**
 * Elenco dei plugin. Allinea anche l'archivio con ServerPlugins/: un file messo lì a mano entra tra le
 * versioni e diventa la scelta. Da chiamare dentro withServerLock.
 */
export async function listPlugins(server: ServerDefinition): Promise<PluginList> {
  const { byName, broken } = await activeFiles(server)
  const addons = await availableAddons()
  const plugins: PluginEntry[] = []
  for (const { addon, path, info } of addons) {
    plugins.push(await addonEntry(server, addon, path, info, byName.get(addon.name)))
    byName.delete(addon.name)
  }
  for (const [name, active] of byName) {
    await storeCopy(server, name, active.path, active.info.id)
    if ((await readSelected(server, name)) !== active.info.id) await writeSelected(server, name, active.info.id)
  }

  let names: string[] = []
  try {
    names = (await readdir(storeRoot(server))).filter((n) => PLUGIN_NAME.test(n) && !isAddon(n))
  } catch {
    // nessun plugin archiviato
  }

  for (const name of new Set([...names, ...byName.keys()])) {
    const versions = await storedVersions(server, name)
    if (!versions.length) continue
    const active = byName.get(name)
    const saved = await readSelected(server, name)
    const selected = active?.info.id ?? (versions.some((v) => v.id === saved) ? saved : versions[0].id)
    const info = (versions.find((v) => v.id === selected) ?? versions[0]).info
    plugins.push({
      name,
      kind: info.kind,
      title: info.title,
      author: info.author,
      description: info.description,
      enabled: active !== undefined,
      selected,
      versions: versions.map(({ info: _i, ...v }) => v),
      error: null,
      file: active?.file ?? null,
      addon: false,
    })
  }
  for (const b of broken) {
    plugins.push({
      name: b.file.slice(0, -4),
      kind: null,
      title: null,
      author: null,
      description: null,
      enabled: true,
      selected: null,
      versions: [],
      error: b.info.error,
      file: b.file,
      addon: false,
    })
  }
  plugins.sort((a, b) => (a.title ?? a.name).localeCompare(b.title ?? b.name, 'it', { sensitivity: 'base' }))

  const bundled: BundledPlugin[] = []
  for (const file of await listDlls(bundledPluginsDir(server))) {
    const found = await fileInfo(join(bundledPluginsDir(server), file))
    if (!found) continue
    bundled.push({
      file,
      kind: found.info?.kind ?? null,
      title: found.info?.title ?? null,
      author: found.info?.author ?? null,
      description: found.info?.description ?? null,
      version: found.info?.version ?? null,
      size: found.size,
    })
  }
  return { plugins, bundled: bundled.sort((a, b) => a.file.localeCompare(b.file)) }
}

// --- Add-on di tModManager -------------------------------------------------------------------------

const isAddon = (name: string) => ADDONS.some((a) => a.name.toLowerCase() === name.toLowerCase())

/** Add-on la cui .dll è disponibile (in sviluppo serve addons/build.sh). */
async function availableAddons(): Promise<{ addon: Addon; path: string; info: FileInfo & { info: AssemblyInfo } }[]> {
  const found = []
  for (const addon of ADDONS) {
    const path = addonPath(addon)
    const info = await fileInfo(path)
    if (info?.info) found.push({ addon, path, info: { ...info, info: info.info } })
  }
  return found
}

/** Copia la .dll distribuita in ServerPlugins/<Nome>.dll (staging e rename), togliendo un file attivo con un altro nome. */
async function installAddon(server: ServerDefinition, addon: Addon, source: string, active: string | null) {
  const dir = activePluginsDir(server)
  await mkdir(dir, { recursive: true })
  const staging = join(dir, `.${addon.name}.dll.${randomBytes(4).toString('hex')}.tmp`)
  await copyFile(source, staging)
  await rename(staging, join(dir, `${addon.name}.dll`))
  if (active && active !== `${addon.name}.dll`) await unlink(join(dir, active)).catch(() => undefined)
}

/** Voce dell'elenco per un add-on; se è attivo con una build diversa da quella del pannello, la aggiorna. */
async function addonEntry(server: ServerDefinition, addon: Addon, path: string, shipped: FileInfo & { info: AssemblyInfo }, active: ActiveFile | undefined): Promise<PluginEntry> {
  if (active && active.info.id !== shipped.id) await installAddon(server, addon, path, active.file)
  return {
    name: addon.name,
    kind: shipped.info.kind,
    title: shipped.info.title,
    author: shipped.info.author ?? 'tModManager',
    description: addon.description,
    enabled: active !== undefined,
    selected: shipped.id,
    versions: [{ id: shipped.id, version: shipped.info.version, size: shipped.size, uploadedAt: new Date(shipped.mtimeMs).toISOString() }],
    error: null,
    file: active ? `${addon.name}.dll` : null,
    addon: true,
  }
}

const addonOnly = (plugin: PluginEntry) => {
  if (plugin.addon) throw new ModError(`${plugin.title ?? plugin.name} è un add-on di tModManager: si attiva o si disattiva soltanto, e si aggiorna con il pannello`, 409)
}

async function findPlugin(server: ServerDefinition, rawName: string | undefined): Promise<PluginEntry> {
  const name = pluginName(rawName)
  const plugin = (await listPlugins(server)).plugins.find((p) => p.name === name)
  if (!plugin) throw new ModError(`Plugin "${name}" non trovato`, 404)
  return plugin
}

const pluginName = (name: string | undefined) => {
  if (!name || !PLUGIN_NAME.test(name)) throw new ModError('Nome del plugin non valido', 422)
  return name
}

const pluginVersionId = (id: string | undefined) => {
  if (!id || !PLUGIN_VERSION_ID.test(id)) throw new ModError('Versione non valida', 422)
  return id
}

/** Impronta dei plugin attivi: se cambia mentre il server è acceso, serve un riavvio. */
export async function pluginsFingerprint(server: ServerDefinition): Promise<string> {
  const files = await listDlls(activePluginsDir(server))
  const parts = await Promise.all(
    files.map(async (f) => {
      const s = await stat(join(activePluginsDir(server), f)).catch(() => null)
      return `${f}:${s?.size ?? 0}:${Math.round(s?.mtimeMs ?? 0)}`
    }),
  )
  return JSON.stringify(parts.sort())
}

/** File da scaricare: una versione salvata. */
export async function pluginVersionPath(server: ServerDefinition, rawName: string | undefined, rawId: string | undefined) {
  const name = pluginName(rawName)
  const id = pluginVersionId(rawId)
  const addon = (await availableAddons()).find((a) => a.addon.name === name)
  if (addon) {
    if (addon.info.id !== id) throw new ModError('Versione non trovata', 404)
    return { path: addon.path, filename: `${name}.dll` }
  }
  const path = versionPath(server, name, id)
  if (!(await stat(path).catch(() => null))) throw new ModError('Versione non trovata', 404)
  return { path, filename: `${name}.dll` }
}

// --- Attivazione ----------------------------------------------------------------------------------------

/** Mette in ServerPlugins/<Plugin>.dll la versione `id`, togliendo l'eventuale file attivo con un altro nome. */
async function activate(server: ServerDefinition, plugin: Pick<PluginEntry, 'name' | 'file'>, id: string) {
  const dir = activePluginsDir(server)
  await mkdir(dir, { recursive: true })
  const target = join(dir, `${plugin.name}.dll`)
  // Copia accanto e rename: TShock non trova mai un file a metà
  const staging = join(dir, `.${plugin.name}.dll.${randomBytes(4).toString('hex')}.tmp`)
  await copyFile(versionPath(server, plugin.name, id), staging)
  await rename(staging, target)
  if (plugin.file && plugin.file !== `${plugin.name}.dll`) await unlink(join(dir, plugin.file)).catch(() => undefined)
  await writeSelected(server, plugin.name, id)
}

async function deactivate(server: ServerDefinition, plugin: Pick<PluginEntry, 'file'>) {
  if (plugin.file) await unlink(join(activePluginsDir(server), plugin.file)).catch(() => undefined)
}

export async function setPluginEnabled(server: ServerDefinition, rawName: string | undefined, enabled: boolean): Promise<PluginEntry> {
  const plugin = await findPlugin(server, rawName)
  if (plugin.error) throw new ModError(`${plugin.file} non è un plugin leggibile: eliminalo o sostituiscilo`, 409)
  const addon = ADDONS.find((a) => a.name === plugin.name)
  if (plugin.addon && addon) {
    if (enabled && !plugin.enabled) await installAddon(server, addon, addonPath(addon), null)
  } else if (enabled && !plugin.enabled && plugin.selected) await activate(server, plugin, plugin.selected)
  if (!enabled && plugin.enabled) await deactivate(server, plugin)
  return findPlugin(server, plugin.name)
}

/** Sceglie la versione da usare; se il plugin è attivo, sostituisce subito il file in ServerPlugins/. */
export async function usePluginVersion(server: ServerDefinition, rawName: string | undefined, rawId: string | undefined): Promise<PluginEntry> {
  const plugin = await findPlugin(server, rawName)
  addonOnly(plugin)
  const id = pluginVersionId(rawId)
  if (!plugin.versions.some((v) => v.id === id)) throw new ModError('Versione non trovata', 404)
  if (plugin.enabled) await activate(server, plugin, id)
  else await writeSelected(server, plugin.name, id)
  return findPlugin(server, plugin.name)
}

// --- Caricamento --------------------------------------------------------------------------------------

export type PluginUploadResult = {
  plugin: PluginEntry
  /** Id della versione caricata. */
  versionId: string
  /** La stessa identica versione era già salvata. */
  duplicate: boolean
  /** Versione che era in uso prima (null se il plugin è nuovo o era già questa). */
  previousVersion: PluginVersion | null
}

/**
 * Riceve una .dll in streaming, controlla che sia un assembly .NET e la aggiunge alle versioni del
 * plugin (riconosciuto dal nome dell'assembly, o dal nome del file). La nuova versione diventa quella
 * scelta, senza cancellare le altre; il plugin si attiva se lo era già o se `enable`.
 */
export async function uploadPlugin(
  server: ServerDefinition,
  filename: string | undefined,
  body: Readable,
  enable: boolean,
  lock: <T>(task: () => Promise<T>) => Promise<T>,
): Promise<PluginUploadResult> {
  const base = (filename ?? '').split(/[\\/]/).pop() ?? ''
  if (!/\.dll$/i.test(base)) throw new ModError('Il file deve essere una .dll', 422)

  await mkdir(paths.tmp(), { recursive: true })
  const tmp = join(paths.tmp(), `plugin-${randomBytes(8).toString('hex')}.dll`)
  try {
    let received = 0
    body.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_UPLOAD_BYTES) body.destroy(new ModError('File troppo grande (max 100 MB)', 413))
    })
    await pipeline(body, createWriteStream(tmp))
    const data = await readFile(tmp)
    const info = readAssemblyInfo(data)
    const name = info.name ?? cleanName(base.slice(0, -4))
    if (!name) throw new ModError('Nome del plugin non valido', 422)
    if (isAddon(name)) throw new ModError(`${name} è un add-on di tModManager: è già nell'elenco dei plugin, basta attivarlo`, 409)
    const id = versionId(data)

    return await lock(async () => {
      const { plugins, bundled } = await listPlugins(server)
      if (bundled.some((b) => b.file.toLowerCase() === `${name}.dll`.toLowerCase())) {
        throw new ModError(`${name}.dll fa parte di TShock: si aggiorna con l'installazione, non da qui`, 409)
      }
      const before = plugins.find((p) => p.name === name)
      const duplicate = before?.versions.some((v) => v.id === id) ?? false
      await storeCopy(server, name, tmp, id, { moveSource: true })
      if (before?.enabled || enable) await activate(server, { name, file: before?.file ?? null }, id)
      else await writeSelected(server, name, id)
      const previous = before?.selected && before.selected !== id ? (before.versions.find((v) => v.id === before.selected) ?? null) : null
      return { plugin: await findPlugin(server, name), versionId: id, duplicate, previousVersion: previous }
    })
  } finally {
    await rm(tmp, { force: true })
  }
}

// --- Eliminazione --------------------------------------------------------------------------------------

/** Una versione nel cestino (si può ripristinare); non quella attiva. Da chiamare dentro withServerLock. */
export async function deletePluginVersion(server: ServerDefinition, rawName: string | undefined, rawId: string | undefined): Promise<PluginEntry | null> {
  const plugin = await findPlugin(server, rawName)
  addonOnly(plugin)
  const id = pluginVersionId(rawId)
  const version = plugin.versions.find((v) => v.id === id)
  if (!version) throw new ModError('Versione non trovata', 404)
  if (plugin.enabled && plugin.selected === id) {
    throw new ModError('È la versione attiva: passa a un\'altra versione o disattiva il plugin prima di eliminarla', 409)
  }
  if (plugin.versions.length === 1) throw new ModError('È l\'unica versione: per toglierla elimina il plugin', 409)
  await trashVersion(server, plugin.name, version)
  if (plugin.selected === id) await writeSelected(server, plugin.name, plugin.versions.find((v) => v.id !== id)!.id)
  return findPlugin(server, plugin.name)
}

/** Tutte le versioni tranne quella scelta, nel cestino. */
export async function deleteOldPluginVersions(server: ServerDefinition, rawName: string | undefined): Promise<{ plugin: PluginEntry; removed: number }> {
  const plugin = await findPlugin(server, rawName)
  addonOnly(plugin)
  const old = plugin.versions.filter((v) => v.id !== plugin.selected)
  for (const version of old) await trashVersion(server, plugin.name, version)
  return { plugin: await findPlugin(server, plugin.name), removed: old.length }
}

async function trashVersion(server: ServerDefinition, name: string, version: PluginVersion) {
  await moveToTrash(server, versionPath(server, name, version.id), {
    kind: 'plugin',
    name: `${name}.dll`,
    root: null,
    path: `version:${version.id}`,
    modName: name,
    modVersion: version.version,
    reason: 'deleted',
  })
}

/** Plugin intero nel cestino: file attivo tolto e tutte le versioni insieme in un solo elemento. */
export async function deletePlugin(server: ServerDefinition, rawName: string | undefined): Promise<void> {
  const plugin = await findPlugin(server, rawName)
  addonOnly(plugin)
  if (plugin.error && plugin.file) {
    // File illeggibile in ServerPlugins/: va nel cestino così com'è
    await moveToTrash(server, join(activePluginsDir(server), plugin.file), {
      kind: 'plugin', name: plugin.file, root: null, path: 'file', modName: null, modVersion: null, reason: 'deleted',
    })
    return
  }
  await deactivate(server, plugin)
  const current = plugin.versions.find((v) => v.id === plugin.selected)
  await moveToTrash(server, storeDir(server, plugin.name), {
    kind: 'plugin',
    name: plugin.title ?? plugin.name,
    root: null,
    path: 'plugin',
    modName: plugin.name,
    modVersion: current?.version ?? null,
    reason: 'deleted',
  })
}

/**
 * Ripristino dal cestino: le versioni tornano nell'archivio (le versioni sono identificate dal contenuto,
 * quindi non c'è mai conflitto); un plugin intero torna disattivato. Da chiamare dentro withServerLock.
 */
export async function restorePlugin(server: ServerDefinition, meta: TrashMeta, from: string, overwrite: boolean) {
  if (meta.path === 'file') {
    const target = join(activePluginsDir(server), meta.name)
    if ((await stat(target).catch(() => null)) && !overwrite) throw new ModError(`${meta.name} è già in ServerPlugins/`, 409)
    await mkdir(activePluginsDir(server), { recursive: true })
    await move(from, target)
    return { replaced: false }
  }

  const name = pluginName(meta.modName ?? undefined)
  if (meta.path?.startsWith('version:')) {
    const id = pluginVersionId(meta.path.slice('version:'.length))
    await storeCopy(server, name, from, id, { moveSource: true })
    await rm(from, { force: true })
    return { replaced: false }
  }

  // Plugin intero: unione delle versioni con quelle eventualmente caricate nel frattempo
  const selected = await readStateFrom(join(from, 'state.json'))
  for (const file of await listDlls(from)) {
    const id = file.slice(0, -4)
    if (PLUGIN_VERSION_ID.test(id)) await storeCopy(server, name, join(from, file), id, { moveSource: true })
  }
  await rm(from, { recursive: true, force: true })
  const plugin = (await listPlugins(server)).plugins.find((p) => p.name === name)
  if (plugin && !plugin.enabled && selected && plugin.versions.some((v) => v.id === selected)) await writeSelected(server, name, selected)
  return { replaced: false }
}

async function readStateFrom(path: string): Promise<string | null> {
  try {
    const { selected } = JSON.parse(await readFile(path, 'utf8')) as { selected?: unknown }
    return typeof selected === 'string' && PLUGIN_VERSION_ID.test(selected) ? selected : null
  } catch {
    return null
  }
}

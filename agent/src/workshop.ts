import { execFile, spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { access, constants, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ADDON_ITEM_ID, addonItemId, findModAddon, isModAddon, modAddonByItemId } from './addons.js'
import { config } from './config.js'
import { paths } from './paths.js'
import { enableMods, installModFile, listMods, MOD_NAME, ModError, type ModEntry, modsDir, readEnabled, withServerLock } from './mods.js'
import { installModAddon, isModAddonInstalled, type ShippedModAddon, shippedModAddon, shippedModAddons } from './modAddons.js'
import type { ServerDefinition } from './registry.js'
import { compareVersions, installedVersion } from './tml.js'
import { type ModInfo, readModInfo } from './tmod.js'

const runFile = promisify(execFile)

/**
 * Mod dello Steam Workshop di tModLoader: collegamento delle mod installate alla loro pagina,
 * controllo degli aggiornamenti (Steam Web API) e download (steamcmd, accesso anonimo).
 *
 * Con la chiave Steam Web API ogni elemento del Workshop dice il nome interno della mod ("name")
 * e quale versione della mod c'è per ogni versione di tModLoader ("versionsummary"). Senza chiave
 * si sa solo la data dell'ultimo aggiornamento, e le mod vanno collegate a mano.
 */

export const TML_APP_ID = 1281930
const API = 'https://api.steampowered.com'
const DETAILS_TTL = 10 * 60 * 1000
/** Una mod non trovata nel Workshop viene ricercata dopo questo tempo (o con "Ricontrolla"). */
const NOT_FOUND_TTL = 7 * 24 * 60 * 60 * 1000
const DOWNLOAD_TIMEOUT = 30 * 60 * 1000

export class WorkshopError extends Error {
  constructor(
    message: string,
    public readonly status: 404 | 409 | 422 | 502 | 503 = 422,
  ) {
    super(message)
  }
}

// --- Formati --------------------------------------------------------------------------------

const VERSION = /^\d+(\.\d+){0,3}$/

/** ID numerico, oppure link a una pagina del Workshop (…/filedetails/?id=123). */
export function parseWorkshopId(input: string): string | null {
  const s = input.trim()
  if (/^\d{1,20}$/.test(s)) return s
  try {
    const url = new URL(s)
    const id = url.searchParams.get('id')
    if (/(^|\.)steamcommunity\.com$/.test(url.hostname) && id && /^\d{1,20}$/.test(id)) return id
  } catch {
    // non è un URL
  }
  return null
}

export type VersionEntry = { tml: string; mod: string }

/** "2026.6.3.4:2.2.4;2022.9.47.46:2.0.2.3" → build della mod per versione di tModLoader. */
export function parseVersionSummary(summary: string | null | undefined): VersionEntry[] {
  if (!summary) return []
  return summary.split(';').flatMap((part) => {
    const [tml, mod] = part.split(':').map((s) => s.trim())
    return tml && mod && VERSION.test(tml) && VERSION.test(mod) ? [{ tml, mod }] : []
  })
}

/**
 * Come tModLoader: si usa la build fatta per la tModLoader più recente non successiva a quella del server.
 * `newer` è una versione più recente che però richiede di aggiornare tModLoader.
 */
export function pickVersion(entries: VersionEntry[], tml: string | null) {
  const byTml = (a: VersionEntry, b: VersionEntry) => compareVersions(a.tml, b.tml) || compareVersions(a.mod, b.mod)
  const sorted = [...entries].sort(byTml)
  const compatible = tml ? sorted.filter((e) => compareVersions(e.tml, tml) <= 0) : sorted
  const latest = compatible.at(-1) ?? null
  const newer = tml
    ? (sorted.filter((e) => compareVersions(e.tml, tml) > 0 && (!latest || compareVersions(e.mod, latest.mod) > 0)).at(-1) ?? null)
    : null
  return { latest, newer }
}

// --- Steam Web API ----------------------------------------------------------------------------

export type WorkshopItem = {
  id: string
  /** false: elemento rimosso, privato o non di tModLoader. */
  found: boolean
  title: string | null
  /** Nome interno della mod (solo con la chiave). */
  modName: string | null
  versions: VersionEntry[]
  timeUpdated: string | null
  fileSize: number | null
  url: string
  /** Tag della pagina del Workshop ("Quality of Life", "Library"…). */
  tags: string[]
  /** Immagine di anteprima della pagina. */
  previewUrl: string | null
  subscriptions: number | null
}

type RawDetails = {
  publishedfileid?: string
  result?: number
  banned?: boolean
  title?: string
  consumer_appid?: number
  consumer_app_id?: number
  time_updated?: number
  file_size?: string | number
  subscriptions?: number
  preview_url?: string
  tags?: { tag?: string; display_name?: string }[]
  kvtags?: { key: string; value: string }[]
  time_created?: number
  short_description?: string
  file_description?: string
  children?: { publishedfileid?: string }[]
  previews?: { url?: string; preview_type?: number }[]
}

const pageUrl = (id: string) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`

export function normalize(raw: RawDetails, id = String(raw.publishedfileid ?? '')): WorkshopItem {
  const kv = new Map((raw.kvtags ?? []).map((t) => [t.key.toLowerCase(), t.value]))
  const app = raw.consumer_appid ?? raw.consumer_app_id
  return {
    id,
    found: raw.result === 1 && !raw.banned && app === TML_APP_ID,
    title: raw.title ?? null,
    modName: kv.get('name') ?? null,
    versions: parseVersionSummary(kv.get('versionsummary')),
    timeUpdated: raw.time_updated ? new Date(raw.time_updated * 1000).toISOString() : null,
    fileSize: raw.file_size !== undefined ? Number(raw.file_size) : null,
    url: pageUrl(id),
    tags: [...new Set((raw.tags ?? []).flatMap((t) => (t.display_name ?? t.tag)?.trim() || []))],
    previewUrl: raw.preview_url || null,
    subscriptions: raw.subscriptions ?? null,
  }
}

async function request(url: string, init?: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) })
  } catch {
    // Il messaggio originale potrebbe contenere l'URL, e quindi la chiave: non si riporta
    throw new WorkshopError('Steam non raggiungibile, riprova tra poco', 502)
  }
  if (response.status === 401 || response.status === 403) {
    throw new WorkshopError('Steam ha rifiutato la chiave Web API: controlla STEAM_API_KEY nel file .env dell\'agent', 502)
  }
  if (!response.ok) throw new WorkshopError(`Steam ha risposto con errore ${response.status}`, 502)
  return response.json()
}

/** Metodo di IPublishedFileService (serve la chiave). */
async function steamService(method: string, input: Record<string, unknown>) {
  const query = new URLSearchParams({ key: config.steamApiKey, input_json: JSON.stringify(input) })
  const data = (await request(`${API}/IPublishedFileService/${method}/v1/?${query}`)) as {
    response?: { total?: number; next_cursor?: string; publishedfiledetails?: RawDetails[] }
  }
  return data.response ?? {}
}

const detailsCache = new Map<string, { at: number; item: WorkshopItem }>()

/** Dettagli degli elementi del Workshop (in cache per 10 minuti). */
export async function fetchDetails(ids: string[], force = false): Promise<Map<string, WorkshopItem>> {
  const result = new Map<string, WorkshopItem>()
  const missing: string[] = []
  for (const id of new Set(ids)) {
    const hit = detailsCache.get(id)
    if (!force && hit && Date.now() - hit.at < DETAILS_TTL) result.set(id, hit.item)
    else missing.push(id)
  }

  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100)
    let raws: RawDetails[]
    if (config.steamApiKey) {
      raws = (await steamService('GetDetails', { publishedfileids: batch, includekvtags: true })).publishedfiledetails ?? []
    } else {
      // Senza chiave: API pubblica, solo titolo e data dell'ultimo aggiornamento
      const form = new URLSearchParams({ itemcount: String(batch.length) })
      batch.forEach((id, n) => form.set(`publishedfileids[${n}]`, id))
      const data = (await request(`${API}/ISteamRemoteStorage/GetPublishedFileDetails/v1/`, { method: 'POST', body: form })) as {
        response?: { publishedfiledetails?: RawDetails[] }
      }
      raws = data.response?.publishedfiledetails ?? []
    }
    for (const id of batch) {
      const raw = raws.find((r) => String(r.publishedfileid) === id)
      const item = raw ? normalize(raw, id) : { ...normalize({}, id), found: false }
      detailsCache.set(id, { at: Date.now(), item })
      result.set(id, item)
    }
  }
  return result
}

/** Cerca l'elemento del Workshop con quel nome interno (serve la chiave). */
async function findByModName(name: string): Promise<WorkshopItem | null> {
  if (!config.steamApiKey) return null
  const res = await steamService('QueryFiles', {
    appid: TML_APP_ID,
    query_type: 0,
    numperpage: 10,
    return_kv_tags: true,
    required_kv_tags: [{ key: 'name', value: name }],
  })
  // Se più elementi dichiarano lo stesso nome (copie, traduzioni) si prende il più seguito
  const candidates = (res.publishedfiledetails ?? [])
    .map((raw) => ({ raw, item: normalize(raw) }))
    .filter(({ item }) => item.found && item.modName === name)
    .sort((a, b) => (b.raw.subscriptions ?? 0) - (a.raw.subscriptions ?? 0))
  const best = candidates[0]?.item ?? null
  if (best) detailsCache.set(best.id, { at: Date.now(), item: best })
  return best
}

export type SearchResult = WorkshopItem

/** Ricerca testuale nel Workshop di tModLoader (serve la chiave). */
export async function searchWorkshop(text: string): Promise<SearchResult[]> {
  if (!config.steamApiKey) throw new WorkshopError('La ricerca nel Workshop richiede la chiave Steam Web API', 503)
  const query = text.trim()
  if (query.length < 2 || query.length > 100) throw new WorkshopError('Scrivi da 2 a 100 caratteri', 422)
  const res = await steamService('QueryFiles', {
    appid: TML_APP_ID,
    query_type: 12,
    search_text: query,
    numperpage: 15,
    return_kv_tags: true,
    return_tags: true,
  })
  return (res.publishedfiledetails ?? [])
    .map((raw) => normalize(raw))
    .filter((item) => item.found)
}

// --- Sfoglia il Workshop -------------------------------------------------------------------------

/** Ordinamenti della ricerca (query_type di IPublishedFileService/QueryFiles). */
export const BROWSE_SORTS = { relevance: 12, popular: 9, trend: 3, recent: 1, updated: 21, votes: 0 } as const
export type BrowseSort = keyof typeof BROWSE_SORTS

export type BrowseItem = WorkshopItem & {
  /** Testo della pagina, senza BBCode (breve nei risultati, completo nel dettaglio). */
  description: string | null
  timeCreated: string | null
  /** Versione della mod adatta alla tModLoader del server (null: nessuna, o versioni non dichiarate). */
  compatibleVersion: string | null
  /** Nessuna build per la tModLoader del server: la prima tModLoader con cui funziona. */
  requiresTml: string | null
  /** ID degli elementi collegati nel Workshop (le dipendenze dichiarate). */
  dependencies: string[]
  /** Add-on di tModManager (es. LiveMap): non viene da Steam, "installarlo" lo copia dal pannello. */
  addon: boolean
}

export type BrowsePage = {
  tmlVersion: string | null
  total: number
  nextCursor: string | null
  items: BrowseItem[]
  /** Perché i risultati di Steam mancano (senza chiave, Steam non risponde): restano gli add-on del pannello. */
  steamError: string | null
}

export type BrowseDetails = BrowseItem & {
  /** Immagini aggiuntive della pagina. */
  images: string[]
  dependencyItems: { id: string; title: string | null; modName: string | null }[]
}

const BBCODE_TAGS = 'b|i|u|s|strike|spoiler|noparse|hr|list|olist|quote|code|table|tr|td|th|url|h[1-6]|p|center|color|size'

/** Descrizione di una pagina del Workshop in testo semplice: via immagini, video e tag, a capo conservati. */
export function bbcodeToText(input: string | null | undefined): string | null {
  if (!input) return null
  const text = input
    .replace(/\r\n?/g, '\n')
    .replace(/\[img\][\s\S]*?\[\/img\]/gi, '')
    .replace(/\[previewyoutube=[^\]]*\](\s*\[\/previewyoutube\])?/gi, '')
    .replace(/\[\*\]\s*/g, '• ')
    .replace(/\[\/(h[1-6]|p|tr|list|olist)\]/gi, '\n')
    .replace(new RegExp(`\\[\\/?(${BBCODE_TAGS})(=[^\\]]*)?\\]`, 'gi'), '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text || null
}

/** Quale versione della mod va bene per la tModLoader del server, o da quale tModLoader in poi funziona. */
export function compatibility(versions: VersionEntry[], tml: string | null): { compatibleVersion: string | null; requiresTml: string | null } {
  if (!versions.length) return { compatibleVersion: null, requiresTml: null }
  const { latest } = pickVersion(versions, tml)
  if (latest) return { compatibleVersion: latest.mod, requiresTml: null }
  const first = [...versions].sort((a, b) => compareVersions(a.tml, b.tml))[0]
  return { compatibleVersion: null, requiresTml: first?.tml ?? null }
}

function browseItem(raw: RawDetails, tml: string | null, description: string | undefined): BrowseItem {
  const item = normalize(raw)
  return {
    ...item,
    description: bbcodeToText(description),
    timeCreated: raw.time_created ? new Date(raw.time_created * 1000).toISOString() : null,
    ...compatibility(item.versions, tml),
    dependencies: (raw.children ?? []).flatMap((c) => (c.publishedfileid && /^\d{1,20}$/.test(String(c.publishedfileid)) ? [String(c.publishedfileid)] : [])),
    addon: false,
  }
}

/** Un add-on di tModManager come elemento del Workshop del pannello. */
function addonBrowseItem(shipped: ShippedModAddon, tml: string | null): BrowseItem {
  // tModLoader rifiuta le mod compilate per una versione più nuova della sua
  const tooOld = tml !== null && compareVersions(tml, shipped.info.tmlVersion) < 0
  return {
    id: addonItemId(shipped.addon),
    found: true,
    title: shipped.info.displayName ?? shipped.addon.name,
    modName: shipped.addon.name,
    versions: [],
    timeUpdated: shipped.mtime.toISOString(),
    fileSize: shipped.size,
    url: '',
    tags: shipped.addon.tags,
    previewUrl: shipped.icon,
    subscriptions: null,
    description: shipped.info.description,
    timeCreated: null,
    compatibleVersion: tooOld ? null : shipped.info.version,
    requiresTml: tooOld ? shipped.info.tmlVersion : null,
    dependencies: [],
    addon: true,
  }
}

/** Add-on che rispondono ai filtri della pagina del Workshop (ricerca e categoria). */
async function matchingAddons(tml: string | null, q: string, tag: string | undefined): Promise<BrowseItem[]> {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  return (await shippedModAddons())
    .filter(({ addon, info }) => {
      if (tag && !addon.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return false
      const text = [info.displayName, info.description, addon.name, ...addon.keywords].join(' ').toLowerCase()
      return words.every((w) => text.includes(w))
    })
    .map((shipped) => addonBrowseItem(shipped, tml))
}

const needKey = () => {
  if (!config.steamApiKey) throw new WorkshopError('Sfogliare il Workshop richiede la chiave Steam Web API (STEAM_API_KEY nel file .env dell\'agent)', 503)
}

/**
 * Una pagina di risultati del Workshop di tModLoader (30 alla volta, si prosegue con `cursor`). In cima alla
 * prima pagina gli add-on di tModManager (es. LiveMap), che ci sono anche senza la chiave di Steam.
 */
export async function browseWorkshop(
  server: ServerDefinition,
  opts: { q?: string; sort?: BrowseSort; tag?: string; cursor?: string },
): Promise<BrowsePage> {
  const q = (opts.q ?? '').trim()
  if (q.length > 100) throw new WorkshopError('Ricerca troppo lunga (massimo 100 caratteri)', 422)
  const tml = await installedVersion(server.installDir)
  const addons = opts.cursor ? [] : await matchingAddons(tml, q, opts.tag)
  const onlyAddons = (steamError: string): BrowsePage => ({ tmlVersion: tml, total: addons.length, nextCursor: null, items: addons, steamError })
  if (!config.steamApiKey) {
    return onlyAddons("Per vedere le mod dello Steam Workshop serve la chiave Steam Web API (STEAM_API_KEY nel file .env dell'agent)")
  }
  try {
    const page = await browseSteam(tml, q, opts)
    return { ...page, total: page.total + addons.length, items: [...addons, ...page.items] }
  } catch (err) {
    if (!addons.length) throw err
    return onlyAddons(err instanceof Error ? err.message : String(err))
  }
}

async function browseSteam(tml: string | null, q: string, opts: { sort?: BrowseSort; tag?: string; cursor?: string }): Promise<BrowsePage> {
  const sort: BrowseSort = opts.sort ?? (q ? 'relevance' : 'popular')
  const input: Record<string, unknown> = {
    appid: TML_APP_ID,
    query_type: BROWSE_SORTS[sort === 'relevance' && !q ? 'popular' : sort],
    cursor: opts.cursor || '*',
    numperpage: 30,
    return_kv_tags: true,
    return_tags: true,
    return_children: true,
    return_short_description: true,
  }
  if (q) input.search_text = q
  if (sort === 'trend') input.days = 7
  if (opts.tag) input.requiredtags = [opts.tag]

  const res = await steamService('QueryFiles', input)
  const items = (res.publishedfiledetails ?? []).map((raw) => browseItem(raw, tml, raw.short_description)).filter((i) => i.found)
  const at = Date.now()
  for (const item of items) detailsCache.set(item.id, { at, item: withoutBrowseFields(item) })
  const next = res.next_cursor && res.next_cursor !== input.cursor && (res.publishedfiledetails ?? []).length > 0 ? res.next_cursor : null
  return { tmlVersion: tml, total: res.total ?? items.length, nextCursor: next, items, steamError: null }
}

const withoutBrowseFields = ({ description: _d, timeCreated: _t, compatibleVersion: _c, requiresTml: _r, dependencies: _p, addon: _a, ...item }: BrowseItem): WorkshopItem => item

/** Pagina completa di un elemento: descrizione, immagini e dipendenze dichiarate. */
export async function workshopItemDetails(server: ServerDefinition, id: string): Promise<BrowseDetails> {
  const addon = modAddonByItemId(id)
  if (addon) {
    const shipped = await shippedModAddon(addon.name)
    if (!shipped) throw new WorkshopError('Add-on non disponibile in questa installazione del pannello', 404)
    return { ...addonBrowseItem(shipped, await installedVersion(server.installDir)), images: [], dependencyItems: [] }
  }
  needKey()
  const [res, tml] = await Promise.all([
    steamService('GetDetails', {
      publishedfileids: [id],
      includekvtags: true,
      includetags: true,
      includechildren: true,
      includeadditionalpreviews: true,
    }),
    installedVersion(server.installDir),
  ])
  const raw = res.publishedfiledetails?.[0]
  const item = raw ? browseItem(raw, tml, raw.file_description) : null
  if (!raw || !item?.found) throw new WorkshopError('Elemento del Workshop non trovato, non pubblico o non di tModLoader', 404)
  detailsCache.set(id, { at: Date.now(), item: withoutBrowseFields(item) })
  const deps = item.dependencies.length ? await fetchDetails(item.dependencies) : new Map<string, WorkshopItem>()
  return {
    ...item,
    images: (raw.previews ?? []).flatMap((p) => (p.preview_type === 0 && p.url ? [p.url] : [])),
    dependencyItems: item.dependencies.map((d) => ({ id: d, title: deps.get(d)?.title ?? null, modName: deps.get(d)?.modName ?? null })),
  }
}

// --- Collegamenti mod → Workshop --------------------------------------------------------------

type Link = { id: string | null; source: 'auto' | 'manual'; checkedAt: string }
type Store = { links: Record<string, Link> }

const storePath = paths.workshopLinks
let storeQueue: Promise<unknown> = Promise.resolve()

async function readStore(): Promise<Store> {
  try {
    const parsed = JSON.parse(await readFile(storePath(), 'utf8')) as Partial<Store>
    return { links: parsed.links && typeof parsed.links === 'object' ? parsed.links : {} }
  } catch {
    return { links: {} }
  }
}

/** Modifica atomica (e in coda) del file dei collegamenti. */
function updateStore(change: (store: Store) => void): Promise<Store> {
  const run = storeQueue.then(async () => {
    const store = await readStore()
    change(store)
    await mkdir(config.dataDir, { recursive: true })
    const tmp = `${storePath()}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`)
    await rename(tmp, storePath())
    return store
  })
  storeQueue = run.catch(() => undefined)
  return run
}

/** ID del Workshop elencati da tModLoader in Mods/install.txt (uno per riga). */
async function installTxtIds(server: ServerDefinition): Promise<string[]> {
  try {
    const text = await readFile(join(modsDir(server), 'install.txt'), 'utf8')
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^\d{1,20}$/.test(l))
  } catch {
    return []
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * Collega in automatico al Workshop le mod che non lo sono ancora (serve la chiave):
 * prima con gli ID di install.txt, poi cercando il nome interno.
 */
async function autoLink(server: ServerDefinition, allNames: string[], force: boolean): Promise<Store> {
  // Gli add-on di tModManager non sono nel Workshop: una mod di Steam con lo stesso nome non è la stessa
  const names = allNames.filter((n) => !isModAddon(n))
  let store = await readStore()
  if (!config.steamApiKey) return store
  const now = Date.now()
  const pending = names.filter((name) => {
    const link = store.links[name]
    if (!link) return true
    if (link.source === 'manual' || link.id) return false
    return force || now - Date.parse(link.checkedAt) > NOT_FOUND_TTL
  })
  if (!pending.length) return store

  const found = new Map<string, string>()
  const fromInstallTxt = await fetchDetails(await installTxtIds(server), force)
  for (const item of fromInstallTxt.values()) {
    if (item.found && item.modName && pending.includes(item.modName)) found.set(item.modName, item.id)
  }
  const rest = pending.filter((name) => !found.has(name))
  const looked = await mapLimit(rest, 4, async (name) => [name, (await findByModName(name))?.id ?? null] as const)
  for (const [name, id] of looked) if (id) found.set(name, id)

  const checkedAt = new Date().toISOString()
  store = await updateStore((s) => {
    for (const name of pending) {
      // Nel frattempo qualcuno può averla collegata a mano: quel collegamento vince
      if (s.links[name]?.source === 'manual') continue
      s.links[name] = { id: found.get(name) ?? null, source: 'auto', checkedAt }
    }
  })
  return store
}

/** Collega a mano una mod a un elemento del Workshop (`input` = link o ID), o la segna come "non nel Workshop" (null). */
export async function setLink(server: ServerDefinition, modName: string, input: string | null): Promise<WorkshopItem | null> {
  if (isModAddon(modName)) throw new WorkshopError('È un add-on di tModManager: non è nello Steam Workshop e si aggiorna con il pannello', 422)
  const mod = (await listMods(server)).mods.find((m) => m.name === modName)
  if (!mod) throw new WorkshopError(`Mod "${modName}" non trovata`, 404)
  let id: string | null = null
  let item: WorkshopItem | undefined
  if (input !== null) {
    id = parseWorkshopId(input)
    if (!id) throw new WorkshopError('Incolla il link della pagina del Workshop oppure il suo ID numerico', 422)
    item = (await fetchDetails([id], true)).get(id)
    if (!item?.found) throw new WorkshopError('Elemento del Workshop non trovato, non pubblico o non di tModLoader', 404)
    if (item.modName && item.modName !== modName) {
      throw new WorkshopError(`Quella pagina del Workshop è della mod "${item.modName}", non di "${modName}"`, 422)
    }
  }
  await updateStore((s) => {
    s.links[modName] = { id, source: 'manual', checkedAt: new Date().toISOString() }
  })
  return item ?? null
}

/** Mod → ID del Workshop, per le mod collegate (in automatico o a mano). */
export async function workshopIds(): Promise<Map<string, string>> {
  const { links } = await readStore()
  return new Map(Object.entries(links).flatMap(([name, link]) => (link.id ? [[name, link.id] as const] : [])))
}

/** Toglie il collegamento manuale: la mod torna a essere collegata in automatico. */
export async function resetLink(modName: string) {
  await updateStore((s) => {
    delete s.links[modName]
  })
}

// --- Controllo degli aggiornamenti ------------------------------------------------------------

export type UpdateStatus =
  /** Installata la versione più recente compatibile. */
  | 'current'
  | 'update'
  /** Senza chiave: aggiornata nel Workshop dopo l'installazione (probabile aggiornamento). */
  | 'maybe'
  /** Nel Workshop non c'è una versione per la tModLoader del server. */
  | 'incompatible'
  /** Non collegata al Workshop. */
  | 'unlinked'
  /** Elemento rimosso o privato. */
  | 'unavailable'

export type ModUpdate = {
  name: string
  displayName: string | null
  installedVersion: string | null
  workshopId: string | null
  link: 'auto' | 'manual' | null
  title: string | null
  url: string | null
  latestVersion: string | null
  /** Versione ancora più recente, che però richiede di aggiornare tModLoader. */
  newerVersion: string | null
  newerRequiresTml: string | null
  timeUpdated: string | null
  status: UpdateStatus
}

export type UpdateReport = {
  apiKey: boolean
  steamcmd: boolean
  /** Perché steamcmd non è utilizzabile (null se lo è). */
  steamcmdProblem: string | null
  tmlVersion: string | null
  checkedAt: string
  mods: ModUpdate[]
  /** Dettagli del Workshop consultati per questo controllo (il sito li conserva nel suo database). */
  items: WorkshopItem[]
}

/**
 * Motivo per cui steamcmd non è utilizzabile, oppure null se lo è.
 * steamcmd è un programma a 32 bit: senza il loader a 32 bit (pacchetto lib32gcc-s1) non parte.
 */
export async function steamcmdProblem(): Promise<string | null> {
  const can = (path: string, mode: number) =>
    access(path, mode).then(
      () => true,
      () => false,
    )
  // Senza steamcmd personalizzato, se manca viene scaricato al primo download
  if (config.steamcmdOverride && !(await can(config.steamcmdOverride, constants.X_OK))) {
    return `steamcmd non è installato (${config.steamcmdOverride})`
  }
  if (!(await can('/lib/ld-linux.so.2', constants.R_OK))) {
    return 'steamcmd non può partire: mancano le librerie a 32 bit (sudo apt install lib32gcc-s1)'
  }
  return null
}

export function modStatus(mod: ModEntry, link: Link | undefined, item: WorkshopItem | undefined, tml: string | null): ModUpdate {
  const base: ModUpdate = {
    name: mod.name,
    displayName: mod.displayName,
    installedVersion: mod.version,
    workshopId: link?.id ?? null,
    link: link?.id ? link.source : link?.source === 'manual' ? 'manual' : null,
    title: item?.title ?? null,
    url: link?.id ? pageUrl(link.id) : null,
    latestVersion: null,
    newerVersion: null,
    newerRequiresTml: null,
    timeUpdated: item?.timeUpdated ?? null,
    status: 'unlinked',
  }
  if (!link?.id) return base
  if (!item?.found) return { ...base, status: 'unavailable' }

  if (!item.versions.length) {
    // Senza chiave (o elemento senza versionsummary): si confrontano le date
    const updatedLater = item.timeUpdated !== null && Date.parse(item.timeUpdated) > Date.parse(mod.modifiedAt)
    return { ...base, status: updatedLater ? 'maybe' : 'current' }
  }

  const { latest, newer } = pickVersion(item.versions, tml)
  const result = {
    ...base,
    latestVersion: latest?.mod ?? null,
    newerVersion: newer?.mod ?? null,
    newerRequiresTml: newer?.tml ?? null,
  }
  if (!latest) return { ...result, status: 'incompatible' }
  if (!mod.version || compareVersions(mod.version, latest.mod) < 0) return { ...result, status: 'update' }
  return { ...result, status: 'current' }
}

export async function checkUpdates(server: ServerDefinition, force = false): Promise<UpdateReport> {
  const mods = (await listMods(server)).mods.filter((m) => m.error === null && !m.addon)
  const store = await autoLink(
    server,
    mods.map((m) => m.name),
    force,
  )
  const ids = mods.flatMap((m) => store.links[m.name]?.id ?? [])
  const details = await fetchDetails(ids, force)
  const tml = await installedVersion(server.installDir)
  const problem = await steamcmdProblem()
  return {
    apiKey: Boolean(config.steamApiKey),
    steamcmd: problem === null,
    steamcmdProblem: problem,
    tmlVersion: tml,
    checkedAt: new Date().toISOString(),
    mods: mods.map((mod) => {
      const link = store.links[mod.name]
      return modStatus(mod, link, link?.id ? details.get(link.id) : undefined, tml)
    }),
    items: [...details.values()],
  }
}

// --- Download con steamcmd ----------------------------------------------------------------------

let steamQueue: Promise<unknown> = Promise.resolve()

/** steamcmd non regge più istanze sulla stessa cartella: i download si fanno uno alla volta. */
function withSteam<T>(task: () => Promise<T>): Promise<T> {
  const run = steamQueue.then(task)
  steamQueue = run.catch(() => undefined)
  return run
}

const steamRoot = paths.workshopDownloads

const STEAMCMD_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz'

/**
 * Scarica steamcmd (tarball ufficiale di Valve) in data/steamcmd se non c'è. Al primo avvio
 * steamcmd si aggiorna da solo (qualche centinaio di MB). Da chiamare dentro withSteam.
 */
async function ensureSteamcmd() {
  const exe = paths.steamcmd()
  if (await access(exe, constants.X_OK).then(() => true, () => false)) return
  if (config.steamcmdOverride) throw new Error(`steamcmd non è installato (${exe})`)

  const dir = paths.steamcmdDir()
  const staging = `${dir}.new`
  const archive = join(paths.tmp(), `steamcmd-${randomBytes(4).toString('hex')}.tar.gz`)
  await mkdir(paths.tmp(), { recursive: true })
  await rm(staging, { recursive: true, force: true })
  try {
    const response = await fetch(STEAMCMD_URL, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(archive))
    await mkdir(staging, { recursive: true })
    await runFile('tar', ['-xzf', archive, '-C', staging])
    if (!(await access(join(staging, 'steamcmd.sh'), constants.X_OK).then(() => true, () => false))) {
      throw new Error('archivio senza steamcmd.sh')
    }
    await rm(dir, { recursive: true, force: true })
    await rename(staging, dir)
  } catch (err) {
    await rm(staging, { recursive: true, force: true })
    throw new Error(`Download di steamcmd non riuscito: ${(err as Error).message}`)
  } finally {
    await rm(archive, { force: true })
  }
}
const contentDir = (id: string) => join(steamRoot(), 'steamapps', 'workshop', 'content', String(TML_APP_ID), id)

/**
 * Spazio occupato davvero su disco (blocchi allocati). steamcmd crea subito i file con la dimensione
 * finale, quindi la dimensione apparente non dice quanto è arrivato: i blocchi sì.
 */
async function allocatedBytes(path: string): Promise<number> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory()) return info.blocks * 512
    let total = 0
    for (const entry of await readdir(path)) total += await allocatedBytes(join(path, entry))
    return total
  } catch {
    return 0
  }
}

const downloadingDir = (id: string) => join(steamRoot(), 'steamapps', 'workshop', 'downloads', String(TML_APP_ID), id)

export type DownloadEvents = {
  /** steamcmd ha cominciato a scaricare l'elemento. */
  onStart: (id: string) => void
  /** Byte arrivati finora (misurati sul disco: steamcmd non stampa l'avanzamento). */
  onProgress: (id: string, bytes: number) => void
  /** Download finito: `dir` contiene l'elemento. */
  onDone: (id: string, dir: string) => void
  onError: (id: string, message: string) => void
}

/** Eventi nell'output di steamcmd. Fine di un elemento e inizio del successivo stanno sulla stessa riga. */
const EVENTS = [
  // Il " ..." finale garantisce che l'ID sia completo anche se l'output arriva spezzato
  { kind: 'start', re: /Downloading item (\d+) \.\.\./ },
  { kind: 'done', re: /Success\. Downloaded item (\d+) to "([^"]+)"/ },
  { kind: 'error', re: /ERROR! Download item (\d+) failed \(([^)]*)\)/ },
] as const

/** Estrae dall'output gli eventi completi, in ordine; restituisce anche il testo non ancora interpretabile. */
export function parseSteamOutput(buffer: string): { events: { kind: 'start' | 'done' | 'error'; id: string; detail: string }[]; rest: string } {
  const events: { kind: 'start' | 'done' | 'error'; id: string; detail: string }[] = []
  let rest = buffer
  for (;;) {
    let first: { kind: 'start' | 'done' | 'error'; match: RegExpExecArray } | null = null
    for (const { kind, re } of EVENTS) {
      const match = re.exec(rest)
      if (match && (!first || match.index < first.match.index)) first = { kind, match }
    }
    if (!first) break
    events.push({ kind: first.kind, id: first.match[1], detail: first.match[2] ?? '' })
    rest = rest.slice(first.match.index + first.match[0].length)
  }
  // Un evento può arrivare spezzato tra due blocchi di output: si tiene la coda
  return { events, rest: rest.slice(-2000) }
}

/**
 * Scarica più elementi del Workshop con un solo collegamento a Steam (il login richiede vari secondi).
 * Gli eventi arrivano man mano, così ogni mod si può installare mentre si scarica la successiva.
 * Gli elementi senza esito alla chiusura di steamcmd vengono segnalati con onError.
 */
export function steamcmdDownloadAll(ids: string[], events: DownloadEvents, signal?: AbortSignal): Promise<void> {
  return withSteam(async () => {
    // Annullato mentre aspettava il proprio turno (steamcmd occupato da un altro server)
    if (signal?.aborted) {
      for (const id of ids) events.onError(id, 'Download annullato')
      return
    }
    try {
      await ensureSteamcmd()
    } catch (err) {
      for (const id of ids) events.onError(id, (err as Error).message)
      return
    }
    await mkdir(steamRoot(), { recursive: true })
    await Promise.all(ids.map((id) => rm(contentDir(id), { recursive: true, force: true })))
    const args = ['+force_install_dir', steamRoot(), '+login', 'anonymous']
    for (const id of ids) args.push('+workshop_download_item', String(TML_APP_ID), id, 'validate')
    args.push('+quit')

    const pending = new Set(ids)
    let current: string | null = null

    await new Promise<void>((resolve) => {
      // Gruppo di processi proprio: steamcmd.sh avvia il vero steamcmd come figlio, e vanno fermati entrambi
      const child = spawn(paths.steamcmd(), args, { cwd: dirname(paths.steamcmd()), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      const kill = (sig: NodeJS.Signals) => {
        try {
          process.kill(-child.pid!, sig)
        } catch {
          child.kill(sig)
        }
      }
      let buffer = ''
      let tail = ''
      // Limite di inattività: si riparte da capo a ogni elemento che comincia o finisce
      let timer = setTimeout(() => kill('SIGKILL'), DOWNLOAD_TIMEOUT)
      const touch = () => {
        clearTimeout(timer)
        timer = setTimeout(() => kill('SIGKILL'), DOWNLOAD_TIMEOUT)
      }
      const onAbort = () => kill('SIGTERM')
      signal?.addEventListener('abort', onAbort, { once: true })

      const collect = (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        tail = (tail + text).slice(-8000)
        const parsed = parseSteamOutput(buffer + text)
        buffer = parsed.rest
        for (const event of parsed.events) {
          if (!pending.has(event.id)) continue
          touch()
          if (event.kind === 'start') {
            current = event.id
            events.onStart(event.id)
          } else {
            pending.delete(event.id)
            if (current === event.id) current = null
            if (event.kind === 'done') events.onDone(event.id, event.detail)
            else events.onError(event.id, `Steam: ${event.detail}`)
          }
        }
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)

      let measuring = false
      const progress = setInterval(() => {
        const id = current
        if (measuring || !id) return
        measuring = true
        void allocatedBytes(downloadingDir(id))
          .then((bytes) => {
            if (bytes > 0 && current === id) events.onProgress(id, bytes)
          })
          .finally(() => {
            measuring = false
          })
      }, 700)

      const finish = (message: string) => {
        clearTimeout(timer)
        clearInterval(progress)
        signal?.removeEventListener('abort', onAbort)
        for (const id of pending) events.onError(id, message)
        pending.clear()
        resolve()
      }
      child.on('error', (err) => finish(`steamcmd non avviabile: ${err.message}`))
      child.on('close', (code, killedBy) => {
        if (signal?.aborted) return finish('Download annullato')
        if (code === 127) return finish('steamcmd non può partire: mancano le librerie a 32 bit (sudo apt install lib32gcc-s1)')
        if (killedBy) return finish('Download interrotto: steamcmd è rimasto fermo per più di 30 minuti')
        const failure = tail.match(/ERROR! ([^\r\n\x1b]+)/)?.[1]
        finish(failure ? `steamcmd: ${failure.trim()}` : `steamcmd si è chiuso senza scaricare la mod (codice ${code})`)
      })
    })
  })
}

/** .tmod contenuti nella cartella scaricata (tModLoader mette le build per le vecchie versioni in sottocartelle). */
async function findTmods(dir: string, depth = 2): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.tmod')) found.push(path)
    else if (entry.isDirectory() && depth > 0) found.push(...(await findTmods(path, depth - 1)))
  }
  return found
}

/** La build giusta per la tModLoader del server: la versione della mod più alta tra quelle compatibili. */
export async function pickBuild(dir: string, modName: string, tml: string | null): Promise<{ path: string; info: ModInfo }> {
  const builds: { path: string; info: ModInfo }[] = []
  for (const path of await findTmods(dir)) {
    try {
      builds.push({ path, info: await readModInfo(path) })
    } catch {
      // file non leggibile: ignorato
    }
  }
  const named = builds.filter((b) => b.info.name === modName)
  if (!named.length) {
    const other = builds[0]?.info.name
    throw new WorkshopError(other ? `L'elemento del Workshop contiene la mod "${other}", non "${modName}"` : 'Nessun file .tmod nel download', 422)
  }
  const compatible = tml ? named.filter((b) => compareVersions(b.info.tmlVersion, tml) <= 0) : named
  if (!compatible.length) {
    throw new WorkshopError(`Nessuna build compatibile con tModLoader ${tml}: aggiorna prima tModLoader`, 422)
  }
  compatible.sort((a, b) => compareVersions(a.info.version, b.info.version) || compareVersions(a.info.tmlVersion, b.info.tmlVersion))
  return compatible.at(-1)!
}

// --- Lavori di download (aggiornamenti e installazioni) ----------------------------------------

export type JobItem = {
  name: string
  workshopId: string
  /** Dipendenza mancante installata in automatico. */
  dependency: boolean
  /** Mod nuova scelta dal Workshop: si installa senza abilitarla (resta in attesa, vedi pendingMods). */
  install: boolean
  from: string | null
  to: string | null
  state: 'queued' | 'downloading' | 'installing' | 'done' | 'skipped' | 'error' | 'cancelled'
  message: string | null
  /** Byte già scaricati (null finché steamcmd si sta collegando a Steam). */
  bytes: number | null
  /** Dimensione dell'elemento nel Workshop, se nota. */
  totalBytes: number | null
}

export type UpdateJob = {
  serverId: string
  state: 'running' | 'done' | 'error'
  startedAt: string
  finishedAt: string | null
  items: JobItem[]
  warnings: string[]
}

type JobRequest = Pick<JobItem, 'name' | 'workshopId' | 'install' | 'from' | 'totalBytes'>

const FINISHED: JobItem['state'][] = ['done', 'skipped', 'error', 'cancelled']

const jobs = new Map<string, UpdateJob>()

/** Sessione di steamcmd in corso per un lavoro: mod che sta scaricando e come fermarla. */
const activeBatches = new WeakMap<UpdateJob, { names: Set<string>; controller: AbortController }>()

export const currentJob = (serverId: string) => jobs.get(serverId) ?? null

const queuedItem = (r: JobRequest, dependency = false): JobItem => ({
  ...r,
  dependency,
  to: null,
  state: 'queued',
  message: null,
  bytes: null,
})

/**
 * Mette in coda le mod indicate. Se per il server c'è già un lavoro in corso si aggiungono a quello
 * (verranno scaricate dopo le mod già avviate); altrimenti parte un lavoro nuovo, in background.
 */
export function enqueue(server: ServerDefinition, requests: JobRequest[]): UpdateJob {
  const running = jobs.get(server.id)
  if (running?.state === 'running') {
    for (const r of requests) {
      const index = running.items.findIndex((i) => i.name === r.name)
      const existing = running.items[index]
      if (existing && !FINISHED.includes(existing.state)) continue
      // Già finita in questo lavoro: si riprova solo se era andata male o era stata annullata
      if (existing && existing.state !== 'error' && existing.state !== 'cancelled') continue
      if (existing) running.items.splice(index, 1)
      running.items.push(queuedItem(r))
    }
    return running
  }

  const job: UpdateJob = {
    serverId: server.id,
    state: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    warnings: [],
    items: requests.map((r) => queuedItem(r)),
  }
  jobs.set(server.id, job)
  void runJob(server, job)
  return job
}

/**
 * Annulla il download di una mod del lavoro in corso. Se steamcmd la sta già scaricando (o la ha
 * nella sessione in corso) lo si ferma: le altre mod di quella sessione tornano in coda e ripartono.
 * Durante l'installazione non si può più annullare.
 */
export function cancelJobItem(serverId: string, name: string): UpdateJob {
  const job = jobs.get(serverId)
  const item = job?.state === 'running' ? job.items.find((i) => i.name === name) : undefined
  if (!job || !item) throw new WorkshopError(`"${name}" non è tra i download in corso`, 404)
  if (item.state === 'installing') throw new WorkshopError('La mod si sta già installando: non si può più annullare', 409)
  if (FINISHED.includes(item.state)) return job
  item.state = 'cancelled'
  item.message = null
  item.bytes = null
  const batch = activeBatches.get(job)
  if (batch?.names.has(name)) batch.controller.abort()
  return job
}

/** Aggiorna dal Workshop le mod indicate (già installate e collegate). */
export async function startUpdate(server: ServerDefinition, names: string[]): Promise<UpdateJob> {
  const problem = await steamcmdProblem()
  if (problem) throw new WorkshopError(problem, 503)
  const unique = [...new Set(names)]
  if (!unique.length) throw new WorkshopError('Nessuna mod indicata', 422)

  const { mods } = await listMods(server)
  const store = await readStore()
  const unknown = unique.filter((n) => !mods.some((m) => m.name === n))
  if (unknown.length) throw new WorkshopError(`Mod non installate: ${unknown.join(', ')}`, 404)
  const addons = unique.filter(isModAddon)
  if (addons.length) throw new WorkshopError(`${addons.join(', ')}: add-on di tModManager, si aggiorna con il pannello`, 422)
  const unlinked = unique.filter((n) => !store.links[n]?.id)
  if (unlinked.length) throw new WorkshopError(`Mod non collegate al Workshop: ${unlinked.join(', ')}`, 422)

  // Dimensioni (per le barre di avanzamento): di solito già in cache dal controllo degli aggiornamenti
  const sizes = await fetchDetails(unique.map((n) => store.links[n].id!)).catch(() => new Map<string, WorkshopItem>())

  return enqueue(
    server,
    unique.map((name) => ({
      name,
      workshopId: store.links[name].id!,
      install: false,
      from: mods.find((m) => m.name === name)?.version ?? null,
      totalBytes: sizes.get(store.links[name].id!)?.fileSize ?? null,
    })),
  )
}

/**
 * Installa dal Workshop gli elementi indicati (ID). Le mod nuove non vengono abilitate: restano
 * "in attesa" finché non si abilitano tutte insieme (applyPending). Una mod già presente si aggiorna.
 * Gli add-on di tModManager (ID "tmm-…") non si scaricano: si copiano subito dal pannello.
 */
export async function startInstall(server: ServerDefinition, ids: string[]): Promise<UpdateJob> {
  const unique = [...new Set(ids)]
  if (!unique.length) throw new WorkshopError('Nessun elemento indicato', 422)
  const addonIds = unique.filter((id) => ADDON_ITEM_ID.test(id))
  const steamIds = unique.filter((id) => !ADDON_ITEM_ID.test(id))

  // Prima tutti i controlli: se qualcosa non va non si installa niente
  let requests: JobRequest[] = []
  if (steamIds.length) {
    needKey()
    const problem = await steamcmdProblem()
    if (problem) throw new WorkshopError(problem, 503)
    const details = await fetchDetails(steamIds, true)
    const { mods } = await listMods(server)
    requests = steamIds.map((id) => {
      const item = details.get(id)
      if (!item?.found) throw new WorkshopError(`Elemento ${id} non trovato nel Workshop di tModLoader`, 404)
      if (!item.modName || !MOD_NAME.test(item.modName)) {
        throw new WorkshopError(`"${item.title ?? id}" non dichiara il nome interno della mod: scaricala da Steam e caricala a mano`, 422)
      }
      if (isModAddon(item.modName)) throw new WorkshopError(`"${item.title ?? id}" ha lo stesso nome di un add-on di tModManager: non si può installare`, 409)
      const installed = mods.find((m) => m.name === item.modName)
      return { name: item.modName, workshopId: id, install: !installed, from: installed?.version ?? null, totalBytes: item.fileSize }
    })
  }
  const tml = await installedVersion(server.installDir)
  const addons = await Promise.all(
    addonIds.map(async (id) => {
      const addon = modAddonByItemId(id)
      const shipped = addon ? await shippedModAddon(addon.name) : null
      if (!shipped) throw new WorkshopError(`Elemento ${id} non disponibile in questa installazione del pannello`, 404)
      if (tml && compareVersions(tml, shipped.info.tmlVersion) < 0) {
        throw new WorkshopError(`${shipped.info.displayName ?? shipped.addon.name} richiede tModLoader ${shipped.info.tmlVersion} o successiva: aggiorna prima tModLoader`, 422)
      }
      return shipped
    }),
  )

  const addonItems: JobItem[] = []
  for (const shipped of addons) addonItems.push(await installAddonItem(server, shipped))

  if (requests.length) {
    // Le mod vengono collegate subito alla loro pagina, così poi si possono aggiornare (un collegamento manuale resta)
    const checkedAt = new Date().toISOString()
    await updateStore((s) => {
      for (const r of requests) if (s.links[r.name]?.source !== 'manual') s.links[r.name] = { id: r.workshopId, source: 'auto', checkedAt }
    })
    const job = enqueue(server, requests)
    job.items.push(...addonItems)
    return job
  }
  return withFinishedItems(server, addonItems)
}

/** Installa un add-on di tModManager come se fosse stato appena scaricato: in Mods/, in attesa di essere abilitato. */
async function installAddonItem(server: ServerDefinition, shipped: ShippedModAddon): Promise<JobItem> {
  const item: JobItem = {
    name: shipped.addon.name,
    workshopId: addonItemId(shipped.addon),
    dependency: false,
    install: true,
    from: null,
    to: shipped.info.version,
    state: 'done',
    message: null,
    bytes: shipped.size,
    totalBytes: shipped.size,
  }
  if (await isModAddonInstalled(server, shipped.addon)) {
    item.install = false
    item.state = 'skipped'
    item.message = 'Già installata'
    return item
  }
  try {
    item.message = (await installModAddon(server, shipped)).warning
    await addPending(server.id, shipped.addon.name)
  } catch (err) {
    item.state = 'error'
    item.message = err instanceof Error ? err.message : String(err)
  }
  return item
}

/** Elementi già conclusi (gli add-on): nel lavoro in corso, se c'è, altrimenti in un lavoro già finito. */
function withFinishedItems(server: ServerDefinition, items: JobItem[]): UpdateJob {
  const running = jobs.get(server.id)
  if (running?.state === 'running') {
    for (const item of items) {
      const index = running.items.findIndex((i) => i.name === item.name)
      if (index >= 0 && FINISHED.includes(running.items[index].state)) running.items.splice(index, 1)
      if (!running.items.some((i) => i.name === item.name)) running.items.push(item)
    }
    return running
  }
  const now = new Date().toISOString()
  const job: UpdateJob = {
    serverId: server.id,
    state: items.some((i) => i.state === 'error') ? 'error' : 'done',
    startedAt: now,
    finishedAt: now,
    items,
    warnings: [],
  }
  jobs.set(server.id, job)
  return job
}

/** Installa dal Workshop le mod indicate per nome interno (es. quelle di un modpack che mancano). */
export async function startInstallByName(server: ServerDefinition, names: string[]): Promise<UpdateJob> {
  const unique = [...new Set(names)]
  if (!unique.length) throw new WorkshopError('Nessuna mod indicata', 422)
  const addonIds = unique.flatMap((n) => {
    const addon = findModAddon(n)
    return addon ? [addonItemId(addon)] : []
  })
  const rest = unique.filter((n) => !isModAddon(n))
  if (!rest.length) return startInstall(server, addonIds)
  needKey()
  const store = await autoLink(server, rest, true)
  const unknown = rest.filter((n) => !store.links[n]?.id)
  if (unknown.length) throw new WorkshopError(`Non trovate nel Workshop: ${unknown.join(', ')}. Caricale a mano.`, 404)
  return startInstall(server, [...rest.map((n) => store.links[n].id!), ...addonIds])
}

/** Installa una mod appena scaricata (cartella `dir`), poi cancella il download. */
async function installDownloaded(server: ServerDefinition, item: JobItem, dir: string, tml: string | null) {
  try {
    const build = await pickBuild(dir, item.name, tml)
    if (item.from && compareVersions(build.info.version, item.from) <= 0) {
      item.state = 'skipped'
      item.to = item.from
      item.message = 'Già installata la versione più recente compatibile'
      return
    }
    item.state = 'installing'
    const result = await withServerLock(server, () => installModFile(server, build.path, build.info, false))
    item.to = build.info.version
    item.state = 'done'
    item.message = result.warning
    if (item.install) await addPending(server.id, item.name)
  } catch (err) {
    item.state = 'error'
    item.message = err instanceof Error ? err.message : String(err)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Scarica tutte le mod indicate con un solo collegamento a Steam e le installa man mano che arrivano. */
async function downloadAndInstall(server: ServerDefinition, job: UpdateJob, items: JobItem[], tml: string | null) {
  if (!items.length) return
  const unknownSize = items.filter((i) => i.totalBytes === null)
  if (unknownSize.length) {
    const details = await fetchDetails(unknownSize.map((i) => i.workshopId)).catch(() => new Map<string, WorkshopItem>())
    for (const item of unknownSize) item.totalBytes = details.get(item.workshopId)?.fileSize ?? null
  }
  // Le mod annullate nel frattempo non contano più
  const itemsOf = (id: string) => items.filter((i) => i.workshopId === id && i.state !== 'cancelled')
  let installs: Promise<unknown> = Promise.resolve()
  const controller = new AbortController()
  activeBatches.set(job, { names: new Set(items.map((i) => i.name)), controller })

  await steamcmdDownloadAll([...new Set(items.map((i) => i.workshopId))], {
    onStart: (id) => {
      for (const item of itemsOf(id)) item.state = 'downloading'
    },
    onProgress: (id, bytes) => {
      // Mai oltre il 99% finché steamcmd non conferma la fine del download
      for (const item of itemsOf(id)) item.bytes = item.totalBytes ? Math.min(bytes, Math.floor(item.totalBytes * 0.99)) : bytes
    },
    onDone: (id, dir) => {
      for (const item of itemsOf(id)) {
        item.bytes = item.totalBytes ?? item.bytes
        item.state = 'installing'
      }
      // Le installazioni vanno in coda tra loro, ma non fermano il download delle mod successive
      const [first] = itemsOf(id)
      if (first) installs = installs.then(() => installDownloaded(server, first, dir, tml))
      else void rm(dir, { recursive: true, force: true }).catch(() => undefined)
    },
    onError: (id, message) => {
      for (const item of itemsOf(id)) {
        if (controller.signal.aborted) {
          // Sessione fermata per annullare un'altra mod: questa riparte con la prossima
          item.state = 'queued'
          item.bytes = null
        } else {
          item.state = 'error'
          item.message = message
        }
      }
    },
  }, controller.signal)
  activeBatches.delete(job)
  await installs
}

/** Mette in coda le dipendenze che mancano alle mod installate finora in questo lavoro. */
async function queueMissingDependencies(server: ServerDefinition, job: UpdateJob) {
  const touched = new Set(job.items.filter((i) => i.state === 'done').map((i) => i.name))
  const { mods } = await listMods(server)
  const missing = [...new Set(mods.filter((m) => touched.has(m.name)).flatMap((m) => m.missingDependencies))].filter(
    (name) => !job.items.some((i) => i.name === name),
  )
  if (!missing.length) return
  const store = await autoLink(server, missing, true)
  for (const name of missing) {
    const id = store.links[name]?.id
    if (!id) {
      job.warnings.push(`Dipendenza "${name}" non trovata nel Workshop: caricala a mano`)
      continue
    }
    job.items.push(queuedItem({ name, workshopId: id, install: false, from: null, totalBytes: null }, true))
  }
}

async function runJob(server: ServerDefinition, job: UpdateJob) {
  const reenabled = new Set<string>()
  try {
    const tml = await installedVersion(server.installDir)
    for (;;) {
      // Mod in coda (anche quelle aggiunte mentre il lavoro era in corso) e poi le loro dipendenze
      let batch: JobItem[]
      while ((batch = job.items.filter((i) => i.state === 'queued')).length) {
        await downloadAndInstall(server, job, batch, tml)
        await queueMissingDependencies(server, job)
      }

      // Le mod aggiornate che erano abilitate trascinano con sé le dipendenze nuove
      const enabled = new Set(await readEnabled(server))
      const reenable = job.items
        .filter((i) => i.state === 'done' && !i.dependency && !i.install && !reenabled.has(i.name) && enabled.has(i.name))
        .map((i) => i.name)
      if (reenable.length) {
        for (const name of reenable) reenabled.add(name)
        try {
          const added = await withServerLock(server, () => enableMods(server, reenable))
          if (added.length) job.warnings.push(`Abilitate anche le dipendenze: ${added.join(', ')}`)
          // L'avviso "caricata ma non abilitata" di prima non vale più
          for (const item of job.items) if (item.message?.startsWith('Caricata ma non abilitata')) item.message = null
        } catch (err) {
          job.warnings.push(err instanceof Error ? err.message : String(err))
        }
      }

      // Nessun await tra questo controllo e la chiusura: una mod aggiunta adesso verrebbe persa
      if (!job.items.some((i) => i.state === 'queued')) break
    }
    job.state = job.items.some((i) => i.state === 'error') ? 'error' : 'done'
  } catch (err) {
    job.warnings.push(err instanceof Error ? err.message : String(err))
    job.state = 'error'
  } finally {
    job.finishedAt = new Date().toISOString()
  }
}

// --- Mod installate dal Workshop in attesa di essere abilitate ---------------------------------

type PendingStore = Record<string, string[]>

const pendingPath = paths.pendingEnable
let pendingQueue: Promise<unknown> = Promise.resolve()

async function readPending(): Promise<PendingStore> {
  try {
    const parsed = JSON.parse(await readFile(pendingPath(), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).map(([id, names]) => [id, Array.isArray(names) ? names.filter((n) => typeof n === 'string' && MOD_NAME.test(n)) : []]),
    )
  } catch {
    return {}
  }
}

/** Modifica atomica (e in coda) dell'elenco delle mod in attesa. */
function updatePending(change: (store: PendingStore) => void): Promise<PendingStore> {
  const run = pendingQueue.then(async () => {
    const store = await readPending()
    change(store)
    for (const [id, names] of Object.entries(store)) if (!names.length) delete store[id]
    await mkdir(config.dataDir, { recursive: true })
    const tmp = `${pendingPath()}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`)
    await rename(tmp, pendingPath())
    return store
  })
  pendingQueue = run.catch(() => undefined)
  return run
}

async function addPending(serverId: string, name: string) {
  await updatePending((s) => {
    s[serverId] = [...new Set([...(s[serverId] ?? []), name])]
  })
}

/** Mod installate dal Workshop e non ancora abilitate (quelle eliminate o abilitate a mano non contano più). */
export async function pendingMods(server: ServerDefinition): Promise<ModEntry[]> {
  const names = (await readPending())[server.id] ?? []
  if (!names.length) return []
  const { mods } = await listMods(server)
  return names.flatMap((name) => mods.find((m) => m.name === name && !m.enabled) ?? [])
}

/** Toglie una mod dall'elenco di quelle in attesa (resta installata, disabilitata). */
export async function dismissPending(server: ServerDefinition, name: string) {
  await updatePending((s) => {
    s[server.id] = (s[server.id] ?? []).filter((n) => n !== name)
  })
}

export type ApplyResult = {
  /** Mod abilitate, dipendenze comprese. */
  enabled: string[]
  /** Mod rimaste in attesa perché non abilitabili (es. dipendenze mancanti). */
  failed: { name: string; message: string }[]
}

/** Abilita tutte insieme le mod in attesa (con le loro dipendenze). Non si può durante un download. */
export async function applyPending(server: ServerDefinition): Promise<ApplyResult> {
  if (jobs.get(server.id)?.state === 'running') throw new WorkshopError('Aspetta la fine dei download prima di abilitare le mod', 409)
  const waiting = await pendingMods(server)
  const result: ApplyResult = { enabled: [], failed: [] }
  await withServerLock(server, async () => {
    // Una alla volta: una mod con una dipendenza mancante non deve bloccare le altre
    for (const mod of waiting) {
      try {
        result.enabled.push(...(await enableMods(server, [mod.name])))
      } catch (err) {
        if (!(err instanceof ModError)) throw err
        result.failed.push({ name: mod.name, message: err.message })
      }
    }
  })
  const failed = new Set(result.failed.map((f) => f.name))
  await updatePending((s) => {
    s[server.id] = (s[server.id] ?? []).filter((n) => failed.has(n))
  })
  result.enabled = [...new Set(result.enabled)]
  return result
}

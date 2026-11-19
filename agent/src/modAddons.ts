import { createHash, randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { MOD_ADDONS, type ModAddon, modAddonPath } from './addons.js'
import { installModFile, modsDir, type UploadResult, withServerLock } from './mods.js'
import { paths } from './paths.js'
import type { ServerDefinition } from './registry.js'
import { type ModInfo, readModIcon, readModInfo } from './tmod.js'

/**
 * Add-on di tModManager che sono mod tModLoader (es. TmmLiveMap). Il .tmod è nell'immagine dell'agent: dal
 * Workshop del pannello "installarlo" lo copia in Mods/ (come una mod scaricata, da abilitare), e da lì è una
 * mod come le altre. Si aggiorna con il pannello: la copia in Mods/ viene sostituita da quella nuova prima di
 * ogni avvio del server e quando si apre l'elenco delle mod.
 */

export type ShippedModAddon = {
  addon: ModAddon
  path: string
  info: ModInfo
  /** icon.png del .tmod, come data URL (per il Workshop del pannello). */
  icon: string | null
  size: number
  mtime: Date
  hash: string
}

const hashCache = new Map<string, { ino: number; mtimeMs: number; size: number; hash: string }>()

/** sha256 del file, ricalcolato solo se cambia (inode, dimensione o data: un file sostituito con rename cambia inode). */
async function fileHash(path: string): Promise<{ hash: string; size: number; mtime: Date } | null> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return null
  const hit = hashCache.get(path)
  if (hit && hit.ino === info.ino && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return { hash: hit.hash, size: info.size, mtime: info.mtime }
  const hash = createHash('sha256').update(await readFile(path)).digest('hex')
  hashCache.set(path, { ino: info.ino, mtimeMs: info.mtimeMs, size: info.size, hash })
  return { hash, size: info.size, mtime: info.mtime }
}

const shippedCache = new Map<string, { hash: string; shipped: ShippedModAddon }>()

/** Add-on il cui .tmod è disponibile (in sviluppo serve addons/build.sh). */
export async function shippedModAddons(): Promise<ShippedModAddon[]> {
  const found: ShippedModAddon[] = []
  for (const addon of MOD_ADDONS) {
    const path = modAddonPath(addon)
    const file = await fileHash(path)
    if (!file) continue
    const hit = shippedCache.get(addon.name)
    if (hit?.hash === file.hash) {
      found.push(hit.shipped)
      continue
    }
    try {
      const info = await readModInfo(path)
      if (info.name !== addon.name) continue
      const icon = await readModIcon(path)
      const shipped = { addon, path, info, icon: icon ? `data:image/png;base64,${icon.toString('base64')}` : null, ...file }
      shippedCache.set(addon.name, { hash: file.hash, shipped })
      found.push(shipped)
    } catch {
      // .tmod illeggibile: l'add-on non compare
    }
  }
  return found
}

export async function shippedModAddon(name: string): Promise<ShippedModAddon | null> {
  return (await shippedModAddons()).find((s) => s.addon.name === name) ?? null
}

const installedPath = (server: ServerDefinition, addon: ModAddon) => join(modsDir(server), `${addon.name}.tmod`)

/** L'add-on è in Mods/ (installato dal Workshop del pannello, o rimesso dal cestino). */
export async function isModAddonInstalled(server: ServerDefinition, addon: ModAddon) {
  return (await stat(installedPath(server, addon)).catch(() => null))?.isFile() ?? false
}

/** "Installa" dal Workshop del pannello: copia il .tmod in Mods/, disabilitato. Da chiamare fuori da withServerLock. */
export async function installModAddon(server: ServerDefinition, shipped: ShippedModAddon): Promise<UploadResult> {
  await mkdir(paths.tmp(), { recursive: true })
  const tmp = join(paths.tmp(), `addon-${randomBytes(6).toString('hex')}.tmod`)
  await copyFile(shipped.path, tmp)
  try {
    return await withServerLock(server, () => installModFile(server, tmp, shipped.info, false))
  } finally {
    await rm(tmp, { force: true })
  }
}

/**
 * Porta gli add-on installati sul server alla versione di questo pannello (sostituzione diretta: le versioni
 * vecchie non vanno nell'archivio, non servono a nessuno). Restituisce i nomi aggiornati.
 */
export async function refreshInstalledModAddons(server: ServerDefinition): Promise<string[]> {
  const updated: string[] = []
  for (const shipped of await shippedModAddons()) {
    const target = installedPath(server, shipped.addon)
    const current = await fileHash(target)
    if (!current || current.hash === shipped.hash) continue
    await withServerLock(server, async () => {
      const staging = join(modsDir(server), `.${shipped.addon.name}.tmod.${randomBytes(4).toString('hex')}.updating`)
      await copyFile(shipped.path, staging)
      await rename(staging, target)
    })
    updated.push(shipped.addon.name)
  }
  return updated
}

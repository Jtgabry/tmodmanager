import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { createModpack, listModpacks } from './modpacks.js'
import { installModFile, listMods, MOD_NAME, ModError, modsDir, tmpDir, withServerLock } from './mods.js'
import type { ServerDefinition } from './registry.js'
import { readModInfo } from './tmod.js'

/**
 * Importazione dei modpack di tModLoader nei modpack del pannello.
 *
 * tModLoader salva i pack in Mods/ModPacks/ in due formati:
 *  - <Nome>.json             → vecchio formato: array JSON dei nomi delle mod
 *  - <Nome>/Mods/enabled.json (+ i .tmod accanto, + ModConfigs/) → formato attuale ("Export")
 * Si possono anche caricare dal browser: il .json, oppure la cartella del pack compressa in .zip.
 * Le mod presenti nel pack vengono installate; il pack diventa un modpack del pannello (non attivo).
 */

const run = promisify(execFile)
const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 4 * 1024 * 1024 * 1024

const packsFolder = (server: ServerDefinition) => join(modsDir(server), 'ModPacks')

export type ImportablePack = { name: string; format: 'json' | 'folder'; mods: number; files: number }

/** Nomi delle mod da un enabled.json o da un pack .json (array di stringhe). */
export function parseModList(text: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    throw new ModError('Il file .json del modpack non è valido')
  }
  if (!Array.isArray(parsed)) throw new ModError('Il .json del modpack deve contenere un elenco di mod')
  const names = parsed.filter((n): n is string => typeof n === 'string' && MOD_NAME.test(n))
  return [...new Set(names)]
}

async function tmodFilesIn(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir)
    const files: string[] = []
    for (const n of names) {
      if (extname(n).toLowerCase() !== '.tmod') continue
      // Solo file normali: niente link simbolici (es. da uno zip costruito ad arte)
      if ((await lstat(join(dir, n))).isFile()) files.push(join(dir, n))
    }
    return files
  } catch {
    return []
  }
}

/** Pack trovati in Mods/ModPacks/ del server. */
export async function listImportable(server: ServerDefinition): Promise<ImportablePack[]> {
  let names: string[]
  try {
    names = await readdir(packsFolder(server))
  } catch {
    return []
  }
  const packs: ImportablePack[] = []
  for (const name of names) {
    const full = join(packsFolder(server), name)
    const info = await lstat(full).catch(() => null)
    if (!info) continue
    try {
      if (info.isFile() && extname(name).toLowerCase() === '.json') {
        const mods = parseModList(await readFile(full, 'utf8'))
        packs.push({ name: basename(name, extname(name)), format: 'json', mods: mods.length, files: 0 })
      } else if (info.isDirectory()) {
        const mods = parseModList(await readFile(join(full, 'Mods', 'enabled.json'), 'utf8'))
        packs.push({ name, format: 'folder', mods: mods.length, files: (await tmodFilesIn(join(full, 'Mods'))).length })
      }
    } catch {
      // pack illeggibile: si salta
    }
  }
  return packs.sort((a, b) => a.name.localeCompare(b.name, 'it'))
}

export type ImportResult = {
  pack: { id: string; name: string; mods: string[] }
  installed: string[]
  updated: string[]
  skipped: { name: string; reason: string }[]
  missing: string[]
}

/** Crea il modpack e installa le mod fornite. `files` vengono copiati (gli originali restano dove sono). */
async function importPack(
  server: ServerDefinition,
  name: string,
  modList: string[],
  files: string[],
  replaceExisting: boolean,
): Promise<ImportResult> {
  return withServerLock(server, async () => {
    const installed: string[] = []
    const updated: string[] = []
    const skipped: ImportResult['skipped'] = []
    const work = join(tmpDir(), `import-${randomBytes(6).toString('hex')}`)
    await mkdir(work, { recursive: true })
    try {
      for (const file of files) {
        const label = basename(file)
        let info
        try {
          info = await readModInfo(file)
        } catch (err) {
          skipped.push({ name: label, reason: `file non valido: ${(err as Error).message}` })
          continue
        }
        const current = (await listMods(server)).mods.find((m) => m.name === info.name)
        if (current && current.version === info.version) {
          skipped.push({ name: info.name, reason: `già installata (stessa versione ${info.version})` })
          continue
        }
        if (current && !replaceExisting) {
          skipped.push({ name: info.name, reason: `già installata la versione ${current.version ?? '?'} (nel pack: ${info.version})` })
          continue
        }
        const copy = join(work, `${info.name}.tmod`)
        await copyFile(file, copy)
        await installModFile(server, copy, info, false)
        ;(current ? updated : installed).push(info.name)
      }

      const present = new Set((await listMods(server)).mods.map((m) => m.name))
      const taken = new Set((await listModpacks(server)).map((p) => p.name.toLowerCase()))
      let packName = name.trim().slice(0, 60) || 'Modpack importato'
      for (let i = 2; taken.has(packName.toLowerCase()); i++) packName = `${name.trim().slice(0, 55)} (${i})`
      const pack = await createModpack(server, { name: packName, description: 'Importato da tModLoader', mods: modList, versions: {} })
      return { pack, installed, updated, skipped, missing: modList.filter((m) => !present.has(m)) }
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })
}

/** Importa un pack dalla cartella Mods/ModPacks/ del server. */
export async function importFromFolder(server: ServerDefinition, name: unknown, replaceExisting: boolean) {
  const pack = (await listImportable(server)).find((p) => p.name === name)
  if (!pack) throw new ModError('Modpack non trovato in Mods/ModPacks', 404)
  const base = join(packsFolder(server), pack.name)
  if (pack.format === 'json') {
    const mods = parseModList(await readFile(`${base}.json`, 'utf8'))
    return importPack(server, pack.name, mods, [], replaceExisting)
  }
  const mods = parseModList(await readFile(join(base, 'Mods', 'enabled.json'), 'utf8'))
  return importPack(server, pack.name, mods, await tmodFilesIn(join(base, 'Mods')), replaceExisting)
}

/** Importa un pack caricato dal browser: .json (elenco di mod) oppure .zip della cartella del pack. */
export async function importUpload(server: ServerDefinition, filename: unknown, body: Readable, replaceExisting: boolean) {
  const original = typeof filename === 'string' ? basename(filename) : ''
  const ext = extname(original).toLowerCase()
  if (ext !== '.json' && ext !== '.zip') throw new ModError('Carica il .json del modpack oppure la sua cartella compressa in .zip')

  await mkdir(tmpDir(), { recursive: true })
  const work = join(tmpDir(), `import-upload-${randomBytes(6).toString('hex')}`)
  await mkdir(work)
  try {
    const archive = join(work, `upload${ext}`)
    let received = 0
    body.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_IMPORT_BYTES) body.destroy(new ModError('File troppo grande (max 2 GB)', 413))
    })
    await pipeline(body, createWriteStream(archive))
    const fallbackName = basename(original, ext)

    if (ext === '.json') {
      return await importPack(server, fallbackName, parseModList(await readFile(archive, 'utf8')), [], replaceExisting)
    }

    // Elenco dei file nello zip: si cerca enabled.json e si controlla la dimensione totale (zip bomb)
    let listing: string
    try {
      listing = (await run('unzip', ['-Z', '-l', archive], { maxBuffer: 32 * 1024 * 1024 })).stdout
    } catch {
      throw new ModError('Il file .zip non è valido')
    }
    const entries = listing
      .split('\n')
      .map((line) => line.match(/^\S+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => ({ size: Number(m[1]), path: m[2] }))
    const relevant = entries.filter((e) => /(^|\/)enabled\.json$/i.test(e.path) || /\.tmod$/i.test(e.path))
    if (relevant.reduce((a, e) => a + e.size, 0) > MAX_EXTRACTED_BYTES) throw new ModError('Lo zip è troppo grande una volta estratto')
    const enabledEntry = relevant
      .filter((e) => /(^|\/)enabled\.json$/i.test(e.path))
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length)[0]
    if (!enabledEntry) throw new ModError('Nello zip non c\'è Mods/enabled.json: è la cartella di un modpack di tModLoader?')

    // Nome del pack: la cartella che contiene Mods/ (es. "MioPack/Mods/enabled.json"), altrimenti il nome dello zip
    const parts = enabledEntry.path.split('/')
    const packName = parts.length >= 3 && parts[parts.length - 2] === 'Mods' ? parts[parts.length - 3] : fallbackName

    // -j: si estraggono solo i nomi dei file, senza percorsi (niente "../" o cartelle arbitrarie)
    const out = join(work, 'out')
    await mkdir(out)
    const modsPrefix = enabledEntry.path.slice(0, -'enabled.json'.length)
    await run('unzip', ['-q', '-j', '-o', archive, `${modsPrefix}*.tmod`, enabledEntry.path, '-d', out]).catch(async () => {
      // Nessun .tmod nella cartella del pack (pack fatto solo di mod del Workshop): basta enabled.json
      await run('unzip', ['-q', '-j', '-o', archive, enabledEntry.path, '-d', out])
    })
    const enabledFile = join(out, 'enabled.json')
    if (!(await lstat(enabledFile)).isFile()) throw new ModError('enabled.json non valido')
    const mods = parseModList(await readFile(enabledFile, 'utf8'))
    return await importPack(server, packName, mods, await tmodFilesIn(out), replaceExisting)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

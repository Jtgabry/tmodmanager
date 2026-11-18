import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { gameLabel } from './games.js'
import type { ServerDefinition } from './registry.js'
import { readServerConfig } from './serverConfig.js'
import { move, moveToTrash, type TrashMeta } from './trash.js'

export class FileError extends Error {
  constructor(
    message: string,
    public readonly status: 404 | 409 | 413 | 422 = 422,
  ) {
    super(message)
  }
}

/**
 * limited = cartella di installazione di tModLoader: si vedono solo i file .txt di primo livello
 * (serverconfig, banlist…) e i log; niente binari, niente creazione/rinomina/eliminazione.
 */
export type FileRoot = { id: string; label: string; path: string; limited: boolean }

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
const MAX_TEXT_BYTES = 1024 * 1024

/** Cartelle navigabili di un server: SaveData, mondi (se fuori da SaveData), installazione del gioco. */
export async function fileRoots(server: ServerDefinition): Promise<FileRoot[]> {
  const roots: FileRoot[] = [{ id: 'save', label: 'SaveData', path: server.saveDir, limited: false }]
  const { world } = await readServerConfig(server.configPath)
  if (world) {
    const worlds = dirname(world)
    if (!isInside(server.saveDir, worlds)) roots.push({ id: 'worlds', label: 'Mondi', path: worlds, limited: false })
  }
  roots.push({ id: 'tml', label: `${gameLabel(server.game)} (config e log)`, path: server.installDir, limited: true })
  // serverconfig.txt nella cartella del server (server creati dal pannello)
  const configDir = dirname(server.configPath)
  if (!isInside(server.saveDir, configDir) && !isInside(server.installDir, configDir)) {
    roots.push({ id: 'config', label: 'Configurazione', path: configDir, limited: true })
  }
  return roots
}

const isInside = (root: string, target: string) => target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)

/** Nome di file/cartella valido (un solo segmento, niente separatori o nomi speciali). */
export function validName(name: unknown): string {
  if (typeof name !== 'string') throw new FileError('Nome mancante')
  const trimmed = name.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..' || /[/\\\0]/.test(trimmed) || trimmed.length > 255) {
    throw new FileError(`Nome non valido: "${name}"`)
  }
  return trimmed
}

type Access = 'list' | 'read' | 'write' | 'modify'

const LOGS_DIR = 'tModLoader-Logs'
const LIMITED_TEXT = /^[^/]+\.txt$/i

/** Regole della radice limitata. `rel` è relativo alla radice, con "/" come separatore. */
export function limitedAllows(rel: string, access: Access): boolean {
  if (rel === '') return access === 'list'
  if (rel === LOGS_DIR || rel.startsWith(`${LOGS_DIR}/`)) return access === 'list' || access === 'read'
  // I .txt di primo livello si possono anche rinominare/eliminare (vanno nel cestino), ma non i binari
  if (LIMITED_TEXT.test(rel)) return true
  return false
}

type Resolved = { root: FileRoot; rootReal: string; absolute: string; relative: string }

/**
 * Traduce (radice, percorso relativo) in un percorso assoluto dentro la radice.
 * Rifiuta "..", percorsi assoluti e link simbolici che portano fuori dalla radice.
 * `mustExist: false` per ciò che si sta per creare: si controlla la cartella che lo conterrà.
 */
export async function resolvePath(
  server: ServerDefinition,
  rootId: unknown,
  path: unknown,
  access: Access,
  mustExist = true,
): Promise<Resolved> {
  const root = (await fileRoots(server)).find((r) => r.id === rootId)
  if (!root) throw new FileError('Cartella radice sconosciuta', 404)
  const rel = typeof path === 'string' ? path : ''
  if (rel.includes('\0')) throw new FileError('Percorso non valido')

  const rootReal = await realpath(root.path).catch(() => {
    throw new FileError(`La cartella ${root.path} non esiste`, 404)
  })
  const absolute = resolve(rootReal, `.${sep}${rel}`)
  if (!isInside(rootReal, absolute)) throw new FileError('Percorso fuori dalla cartella consentita')

  // Anche seguendo i link simbolici si deve restare dentro la radice
  const existing = mustExist ? absolute : dirname(absolute)
  let real: string
  try {
    real = await realpath(existing)
  } catch {
    throw new FileError('File o cartella non trovati', 404)
  }
  if (!isInside(rootReal, real)) throw new FileError('Il percorso porta fuori dalla cartella consentita (link simbolico)')

  const rel2 = relative(rootReal, absolute).split(sep).join('/')
  if (root.limited && !limitedAllows(rel2, access)) {
    throw new FileError(
      access === 'list' || access === 'read'
        ? 'File non accessibile: della cartella di tModLoader si vedono solo i file .txt e i log'
        : 'Operazione non consentita nella cartella di tModLoader (solo modifica dei file .txt)',
      access === 'list' || access === 'read' ? 404 : 422,
    )
  }
  return { root, rootReal, absolute, relative: rel2 }
}

export type FileEntry = {
  name: string
  type: 'file' | 'dir' | 'link' | 'other'
  size: number
  modifiedAt: string
}

export async function listDirectory(server: ServerDefinition, rootId: unknown, path: unknown) {
  const target = await resolvePath(server, rootId, path, 'list')
  const info = await stat(target.absolute)
  if (!info.isDirectory()) throw new FileError('Non è una cartella')

  const names = await readdir(target.absolute)
  const entries = await Promise.all(
    names.map(async (name): Promise<FileEntry | null> => {
      try {
        const l = await lstat(join(target.absolute, name))
        let type: FileEntry['type'] = l.isDirectory() ? 'dir' : l.isFile() ? 'file' : 'other'
        let size = l.size
        if (l.isSymbolicLink()) {
          // Un link si mostra come ciò a cui punta, purché resti nella radice
          try {
            const real = await realpath(join(target.absolute, name))
            const s = await stat(real)
            type = isInside(target.rootReal, real) ? (s.isDirectory() ? 'dir' : 'file') : 'link'
            size = s.size
          } catch {
            type = 'link'
          }
        }
        return { name, type, size, modifiedAt: l.mtime.toISOString() }
      } catch {
        return null
      }
    }),
  )

  const visible = (e: FileEntry | null): e is FileEntry => {
    if (e === null) return false
    if (!target.root.limited) return true
    const rel = target.relative === '' ? e.name : `${target.relative}/${e.name}`
    return limitedAllows(rel, e.type === 'dir' ? 'list' : 'read')
  }
  return {
    root: target.root.id,
    path: target.relative === '' ? '' : target.relative,
    limited: target.root.limited,
    entries: entries
      .filter(visible)
      .sort((a, b) => (a.type === 'dir') !== (b.type === 'dir') ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, 'it', { numeric: true })),
  }
}

/** Download: file così com'è, cartella come .zip generato al volo. */
export async function openDownload(server: ServerDefinition, rootId: unknown, path: unknown) {
  const target = await resolvePath(server, rootId, path, 'read')
  const info = await stat(target.absolute)
  const name = target.relative === '' ? basename(target.rootReal) : basename(target.absolute)

  if (info.isFile()) {
    return { filename: name, size: info.size, stream: createReadStream(target.absolute) as Readable }
  }
  if (!info.isDirectory()) throw new FileError('Non è un file scaricabile')

  // -y: i link simbolici restano link (non si segue niente fuori dalla cartella); "-" = output su stdout
  const zip = spawn('zip', ['-q', '-r', '-y', '-', '--', basename(target.absolute)], {
    cwd: dirname(target.absolute),
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return { filename: `${name}.zip`, size: null, stream: zip.stdout as Readable }
}

/** Upload in streaming: si scrive accanto alla destinazione e poi si rinomina (niente file a metà). */
export async function uploadFile(
  server: ServerDefinition,
  rootId: unknown,
  dirPath: unknown,
  name: unknown,
  body: Readable,
  overwrite: boolean,
) {
  const fileName = validName(name)
  const dir = await resolvePath(server, rootId, dirPath, 'list')
  if (!(await stat(dir.absolute)).isDirectory()) throw new FileError('La destinazione non è una cartella')
  const destination = join(dir.absolute, fileName)
  const destinationRel = dir.relative === '' ? fileName : `${dir.relative}/${fileName}`
  if (dir.root.limited && !limitedAllows(destinationRel, 'write')) {
    throw new FileError('Nella cartella di tModLoader si possono caricare solo file .txt (es. serverconfig.txt)')
  }

  const existing = await lstat(destination).catch(() => null)
  if (existing?.isDirectory()) throw new FileError(`Esiste già una cartella "${fileName}"`, 409)
  if (existing && !overwrite) throw new FileError(`Il file "${fileName}" esiste già`, 409)

  const staging = join(dir.absolute, `.${fileName}.${randomBytes(4).toString('hex')}.uploading`)
  try {
    let received = 0
    body.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_UPLOAD_BYTES) body.destroy(new FileError('File troppo grande (max 2 GB)', 413))
    })
    await pipeline(body, createWriteStream(staging, { flags: 'wx' }))
    if (existing) await moveToTrash(server, destination, fileTrashInfo(dir.root.id, destinationRel, 'replaced'), { copy: true })
    await rename(staging, destination)
  } finally {
    await rm(staging, { force: true })
  }
  const info = await stat(destination)
  return { name: fileName, size: info.size, replaced: Boolean(existing) }
}

export async function makeDirectory(server: ServerDefinition, rootId: unknown, dirPath: unknown, name: unknown) {
  const folder = validName(name)
  const dir = await resolvePath(server, rootId, dirPath, 'modify')
  const target = join(dir.absolute, folder)
  if (await lstat(target).catch(() => null)) throw new FileError(`"${folder}" esiste già`, 409)
  await mkdir(target)
  return { name: folder }
}

export async function renameEntry(server: ServerDefinition, rootId: unknown, path: unknown, newName: unknown) {
  const name = validName(newName)
  const source = await resolvePath(server, rootId, path, 'modify')
  if (source.relative === '') throw new FileError('Non si può rinominare la cartella radice')
  const destination = join(dirname(source.absolute), name)
  const destinationRel = [...source.relative.split('/').slice(0, -1), name].join('/')
  if (source.root.limited && !limitedAllows(destinationRel, 'modify')) {
    throw new FileError('Nella cartella di tModLoader i file devono restare .txt')
  }
  if (await lstat(destination).catch(() => null)) throw new FileError(`"${name}" esiste già`, 409)
  await rename(source.absolute, destination)
  return { name }
}

const fileTrashInfo = (root: string, rel: string, reason: TrashMeta['reason']) => ({
  kind: 'file' as const,
  name: basename(rel),
  root,
  path: rel,
  modName: null,
  modVersion: null,
  reason,
})

/** Eliminazione = spostamento nel cestino dell'agent (vedi trash.ts). */
export async function deleteEntry(server: ServerDefinition, rootId: unknown, path: unknown) {
  const target = await resolvePath(server, rootId, path, 'modify')
  if (target.relative === '') throw new FileError('Non si può eliminare la cartella radice')
  await moveToTrash(server, target.absolute, fileTrashInfo(target.root.id, target.relative, 'deleted'))
}

/**
 * Rimette al suo posto un file o una cartella del cestino.
 * Se al suo posto c'è già qualcosa: 409, oppure (overwrite) quello attuale va a sua volta nel cestino.
 */
export async function restoreEntry(server: ServerDefinition, meta: TrashMeta, itemPath: string, overwrite: boolean) {
  if (!meta.root || meta.path === null) throw new FileError('Origine sconosciuta: impossibile ripristinare')
  const access: Access = meta.isDir ? 'modify' : 'write'
  const target = await resolvePath(server, meta.root, meta.path, access, false).catch((err) => {
    if (err instanceof FileError && err.status === 404) {
      throw new FileError(`La cartella di origine di "${meta.path}" non esiste più: ricreala prima di ripristinare`, 422)
    }
    throw err
  })
  const existing = await lstat(target.absolute).catch(() => null)
  if (existing && !overwrite) {
    throw new FileError(`Esiste già "${meta.path}"`, 409)
  }
  if (existing) await moveToTrash(server, target.absolute, fileTrashInfo(target.root.id, target.relative, 'replaced'))
  await move(itemPath, target.absolute)
  return { root: meta.root, path: meta.path, replaced: Boolean(existing) }
}

/** Contenuto di un file di testo (max 1 MB, UTF-8) per modificarlo dal browser. */
export async function readText(server: ServerDefinition, rootId: unknown, path: unknown) {
  const target = await resolvePath(server, rootId, path, 'read')
  const info = await stat(target.absolute)
  if (!info.isFile()) throw new FileError('Non è un file')
  if (info.size > MAX_TEXT_BYTES) throw new FileError('File troppo grande per l\'editor (max 1 MB): scaricalo')
  const buffer = await readFile(target.absolute)
  if (buffer.includes(0)) throw new FileError('Il file non è di testo')
  return { content: buffer.toString('utf8'), modifiedAt: info.mtime.toISOString() }
}

/**
 * Salva un file di testo. `expectedModifiedAt` evita di sovrascrivere modifiche fatte nel frattempo
 * (da un'altra persona o dal server stesso): in quel caso 409.
 */
export async function writeText(
  server: ServerDefinition,
  rootId: unknown,
  path: unknown,
  content: unknown,
  expectedModifiedAt: unknown,
) {
  if (typeof content !== 'string') throw new FileError('Contenuto mancante')
  if (Buffer.byteLength(content) > MAX_TEXT_BYTES) throw new FileError('Contenuto troppo grande (max 1 MB)', 413)
  const target = await resolvePath(server, rootId, path, 'write')
  const info = await stat(target.absolute)
  if (!info.isFile()) throw new FileError('Non è un file')
  if (typeof expectedModifiedAt === 'string' && info.mtime.toISOString() !== expectedModifiedAt) {
    throw new FileError('Il file è stato modificato nel frattempo: ricaricalo prima di salvare', 409)
  }
  const tmp = join(dirname(target.absolute), `.${basename(target.absolute)}.${randomBytes(4).toString('hex')}.tmp`)
  await writeFile(tmp, content, { mode: info.mode })
  await rename(tmp, target.absolute)
  return { modifiedAt: (await stat(target.absolute)).mtime.toISOString() }
}

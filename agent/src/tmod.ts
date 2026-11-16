import { type FileHandle, open } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'

/**
 * Lettore dell'intestazione dei file .tmod di tModLoader 1.4:
 *   "TMOD" · tmlVersion · hash(20) · firma(256) · lunghezza dati(u32) ·
 *   nome · versione · n.file(i32) · [percorso, lunghezza, lunghezza compressa]… · dati dei file
 * Il file "Info" contiene le build properties (dipendenze, autore, descrizione…).
 * Si leggono solo i byte necessari: alcune mod superano i 100 MB.
 */

export type ModInfo = {
  name: string
  version: string
  /** Versione di tModLoader con cui è stata compilata. */
  tmlVersion: string
  displayName: string | null
  author: string | null
  description: string | null
  homepage: string | null
  /** Dipendenze obbligatorie (nomi interni, senza versione). */
  modReferences: string[]
  /** Dipendenze opzionali. */
  weakReferences: string[]
  /** 0 = Both, 1 = Client, 2 = Server, 3 = NoSync */
  side: number | null
  /** Il file contiene icon.png (l'icona mostrata nel gioco). */
  hasIcon: boolean
}

export class TmodError extends Error {}

const SIDES = ['both', 'client', 'server', 'noSync'] as const
/** Se il tag manca, la mod è "Both" (il default di tModLoader). */
export const sideName = (side: number | null) => SIDES[side ?? 0] ?? 'both'

/** Lettura sequenziale da un buffer con stringhe nel formato .NET (lunghezza 7-bit + UTF-8). */
class Reader {
  constructor(
    private buf: Buffer,
    public pos = 0,
  ) {}

  get remaining() {
    return this.buf.length - this.pos
  }

  private need(n: number) {
    if (this.pos + n > this.buf.length) throw new RangeError('fine del buffer')
  }

  byte() {
    this.need(1)
    return this.buf[this.pos++]
  }

  int32() {
    this.need(4)
    const v = this.buf.readInt32LE(this.pos)
    this.pos += 4
    return v
  }

  uint32() {
    this.need(4)
    const v = this.buf.readUInt32LE(this.pos)
    this.pos += 4
    return v
  }

  bytes(n: number) {
    this.need(n)
    const v = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return v
  }

  string() {
    let length = 0
    let shift = 0
    for (;;) {
      const b = this.byte()
      length |= (b & 0x7f) << shift
      if (b < 0x80) break
      shift += 7
      if (shift > 28) throw new TmodError('Lunghezza stringa non valida')
    }
    return this.bytes(length).toString('utf8')
  }
}

const LIST_TAGS = new Set(['dllReferences', 'modReferences', 'weakReferences', 'sortAfter', 'sortBefore'])
const STRING_TAGS = new Set(['author', 'version', 'displayName', 'homepage', 'description', 'eacPath', 'buildVersion', 'languageVersion'])
const FLAG_TAGS = new Set(['noCompile', '!hideCode', '!hideResources', 'includeSource', 'includePDB', 'playableOnPreview', 'translationMod'])

/** "CalamityMod@2.0.4" → "CalamityMod" */
const referenceName = (ref: string) => ref.split('@')[0].trim()

/** Interpreta il file Info (BuildProperties). Su un tag sconosciuto si ferma e tiene quanto letto. */
export function parseBuildProperties(data: Buffer) {
  const r = new Reader(data)
  const lists: Record<string, string[]> = {}
  const strings: Record<string, string> = {}
  let side: number | null = null
  try {
    for (;;) {
      const tag = r.string()
      if (tag === '') break
      if (LIST_TAGS.has(tag)) {
        const items: string[] = []
        for (let item = r.string(); item !== ''; item = r.string()) items.push(item)
        lists[tag] = items
      } else if (STRING_TAGS.has(tag)) {
        strings[tag] = r.string()
      } else if (tag === 'side') {
        side = r.byte()
      } else if (!FLAG_TAGS.has(tag)) {
        break
      }
    }
  } catch {
    // Info troncato o di un formato più nuovo: si usa quanto letto
  }
  return {
    modReferences: (lists.modReferences ?? []).map(referenceName),
    weakReferences: (lists.weakReferences ?? []).map(referenceName),
    author: strings.author ?? null,
    displayName: strings.displayName ?? null,
    description: strings.description ?? null,
    homepage: strings.homepage ?? null,
    side,
  }
}

type Header = { tmlVersion: string; name: string; version: string; entries: { path: string; length: number; compressed: number }[]; dataStart: number }

/** Intestazione e tabella dei file interni. Lancia TmodError se non è un .tmod valido. */
async function readHeader(file: FileHandle): Promise<Header> {
  const { size } = await file.stat()
  let buf = Buffer.alloc(Math.min(size, 256 * 1024))
  await file.read({ buffer: buf, position: 0 })

  // L'intestazione e la tabella dei file stanno quasi sempre nei primi KB; se no, si legge di più
  const parseHeader = (): Header => {
    const r = new Reader(buf)
    if (r.bytes(4).toString('latin1') !== 'TMOD') throw new TmodError('Non è un file .tmod (intestazione mancante)')
    const tmlVersion = r.string()
    r.bytes(20) // hash
    r.bytes(256) // firma
    r.uint32() // lunghezza dati
    const name = r.string()
    const version = r.string()
    const count = r.int32()
    if (count < 0 || count > 1_000_000) throw new TmodError('Tabella dei file non valida')
    const entries: Header['entries'] = []
    for (let i = 0; i < count; i++) entries.push({ path: r.string(), length: r.int32(), compressed: r.int32() })
    return { tmlVersion, name, version, entries, dataStart: r.pos }
  }

  for (;;) {
    try {
      const header = parseHeader()
      if (!/^[A-Za-z0-9_]+$/.test(header.name)) throw new TmodError(`Nome interno della mod non valido: "${header.name}"`)
      return header
    } catch (err) {
      if (!(err instanceof RangeError) || buf.length >= size) {
        throw err instanceof TmodError ? err : new TmodError('File .tmod troncato o corrotto')
      }
      buf = Buffer.alloc(Math.min(size, buf.length * 4))
      await file.read({ buffer: buf, position: 0 })
    }
  }
}

/** Contenuto (decompresso) di un file interno, oppure null se non c'è o supera `maxBytes`. */
async function readEntry(file: FileHandle, header: Header, path: string, maxBytes: number): Promise<Buffer | null> {
  let offset = header.dataStart
  for (const entry of header.entries) {
    if (entry.path === path) {
      if (entry.compressed < 0 || entry.length < 0 || entry.length > maxBytes || entry.compressed > maxBytes) return null
      const raw = Buffer.alloc(entry.compressed)
      await file.read({ buffer: raw, position: offset })
      return entry.compressed === entry.length ? raw : inflateRawSync(raw, { maxOutputLength: maxBytes })
    }
    offset += entry.compressed
  }
  return null
}

/** Legge le informazioni di una mod dal file. Lancia TmodError se non è un .tmod valido. */
export async function readModInfo(path: string): Promise<ModInfo> {
  const file = await open(path)
  try {
    const header = await readHeader(file)
    const info = await readEntry(file, header, 'Info', 1024 * 1024)
    const properties = info ? parseBuildProperties(info) : null

    return {
      name: header.name,
      version: header.version,
      tmlVersion: header.tmlVersion,
      displayName: properties?.displayName ?? null,
      author: properties?.author ?? null,
      description: properties?.description ?? null,
      homepage: properties?.homepage ?? null,
      modReferences: properties?.modReferences ?? [],
      weakReferences: properties?.weakReferences ?? [],
      side: properties?.side ?? null,
      hasIcon: header.entries.some((e) => e.path === 'icon.png'),
    }
  } finally {
    await file.close()
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Icona della mod (icon.png, 80×80, quella mostrata nel gioco), oppure null se non c'è.
 * Le altre immagini nei .tmod sono convertite in "rawimg", ma icon.png resta un PNG vero.
 */
export async function readModIcon(path: string): Promise<Buffer | null> {
  const file = await open(path)
  try {
    const icon = await readEntry(file, await readHeader(file), 'icon.png', 512 * 1024)
    return icon && icon.subarray(0, 8).equals(PNG_SIGNATURE) ? icon : null
  } catch {
    return null
  } finally {
    await file.close()
  }
}

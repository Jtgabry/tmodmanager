import { open, readFile, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { crc32, deflateRaw } from 'node:zlib'

/**
 * Scrittura (e lettura del commento) di archivi .zip, con il solo zlib di Node: abbastanza per i
 * backup dei mondi (pochi file, ognuno sotto i 4 GB, niente zip64).
 */

const deflate = promisify(deflateRaw)
const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_CENTRAL_DIR = 0x06054b50
const MAX_SIZE = 0xffffffff
/** Versione 2.0 (deflate); bit 11 del flag = nomi in UTF-8. */
const VERSION = 20
const UTF8 = 0x0800
const DEFLATE = 8

/** Data e ora nel formato MS-DOS usato dagli zip (ora locale, risoluzione 2 secondi). */
function dosDateTime(date: Date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

export type ZipEntry = { name: string; path: string }

/** Crea `target` con i file indicati (nome nell'archivio → file su disco) e un commento facoltativo. */
export async function writeZip(target: string, entries: ZipEntry[], comment = '') {
  const file = await open(target, 'wx')
  try {
    const central: Buffer[] = []
    let offset = 0
    for (const entry of entries) {
      const data = await readFile(entry.path)
      if (data.length > MAX_SIZE) throw new Error(`${entry.name} è troppo grande per uno zip (oltre 4 GB)`)
      const compressed = await deflate(data, { level: 6 })
      const crc = crc32(data)
      const name = Buffer.from(entry.name, 'utf8')
      const { time, date } = dosDateTime((await stat(entry.path)).mtime)

      const local = Buffer.alloc(30)
      local.writeUInt32LE(LOCAL_HEADER, 0)
      local.writeUInt16LE(VERSION, 4)
      local.writeUInt16LE(UTF8, 6)
      local.writeUInt16LE(DEFLATE, 8)
      local.writeUInt16LE(time, 10)
      local.writeUInt16LE(date, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(compressed.length, 18)
      local.writeUInt32LE(data.length, 22)
      local.writeUInt16LE(name.length, 26)
      local.writeUInt16LE(0, 28)
      await file.write(Buffer.concat([local, name]))
      await file.write(compressed)

      const header = Buffer.alloc(46)
      header.writeUInt32LE(CENTRAL_HEADER, 0)
      header.writeUInt16LE((3 << 8) | VERSION, 4) // creato su Unix: i permessi qui sotto valgono
      header.writeUInt16LE(VERSION, 6)
      header.writeUInt16LE(UTF8, 8)
      header.writeUInt16LE(DEFLATE, 10)
      header.writeUInt16LE(time, 12)
      header.writeUInt16LE(date, 14)
      header.writeUInt32LE(crc, 16)
      header.writeUInt32LE(compressed.length, 20)
      header.writeUInt32LE(data.length, 24)
      header.writeUInt16LE(name.length, 28)
      header.writeUInt32LE((0o100644 << 16) >>> 0, 38) // permessi Unix del file
      header.writeUInt32LE(offset, 42)
      central.push(header, name)

      offset += local.length + name.length + compressed.length
      if (offset > MAX_SIZE) throw new Error('Archivio troppo grande (oltre 4 GB)')
    }

    const directory = Buffer.concat(central)
    const note = Buffer.from(comment, 'utf8').subarray(0, 0xffff)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(END_OF_CENTRAL_DIR, 0)
    end.writeUInt16LE(entries.length, 8)
    end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(directory.length, 12)
    end.writeUInt32LE(offset, 16)
    end.writeUInt16LE(note.length, 20)
    await file.write(Buffer.concat([directory, end, note]))
  } finally {
    await file.close()
  }
}

/** Commento dell'archivio ('' se non c'è o il file non è uno zip). */
export async function readZipComment(path: string): Promise<string> {
  const file = await open(path)
  try {
    const { size } = await file.stat()
    const length = Math.min(size, 22 + 0xffff)
    const { buffer } = await file.read({ buffer: Buffer.alloc(length), position: size - length })
    for (let i = length - 22; i >= 0; i--) {
      if (buffer.readUInt32LE(i) !== END_OF_CENTRAL_DIR) continue
      const commentLength = buffer.readUInt16LE(i + 20)
      if (i + 22 + commentLength === length) return buffer.toString('utf8', i + 22, i + 22 + commentLength)
    }
    return ''
  } finally {
    await file.close()
  }
}

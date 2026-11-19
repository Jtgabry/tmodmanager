import { crc32, deflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
 * PNG RGB a 8 bit da pixel 0xRRGGBB (riga per riga, `stride` pixel per riga a partire da `offset`).
 * Filtro Sub: cielo, pietra e sfondi uniformi diventano zeri e si comprimono molto.
 */
export function encodePng(pixels: Uint32Array, width: number, height: number, stride = width, offset = 0): Buffer {
  const rowBytes = 1 + width * 3
  const raw = Buffer.alloc(rowBytes * height)
  for (let y = 0; y < height; y++) {
    const row = y * rowBytes
    raw[row] = 1
    let prev = 0
    for (let x = 0; x < width; x++) {
      const p = pixels[offset + y * stride + x]
      const i = row + 1 + x * 3
      raw[i] = ((p >> 16) - (prev >> 16)) & 0xff
      raw[i + 1] = ((p >> 8) - (prev >> 8)) & 0xff
      raw[i + 2] = (p - prev) & 0xff
      prev = p
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit per canale
  header[9] = 2 // RGB
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** PNG RGBA a 8 bit (con trasparenza) da byte RGBA riga per riga, come le texture "rawimg" di tModLoader. */
export function encodePngRgba(rgba: Buffer, width: number, height: number): Buffer {
  const rowBytes = 1 + width * 4
  const raw = Buffer.alloc(rowBytes * height)
  for (let y = 0; y < height; y++) {
    raw[y * rowBytes] = 0 // nessun filtro: gli sprite hanno pochi pixel uguali di fila
    rgba.copy(raw, y * rowBytes + 1, y * width * 4, (y + 1) * width * 4)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6 // RGBA
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

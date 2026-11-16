// Genera le icone della PWA e la favicon a partire da icon/tmodmanager-icon.png (sfondo trasparente).
// Uso: npm run icons  →  scrive i file in public/ (vanno poi committati).
import { writeFile } from 'node:fs/promises'
import sharp from 'sharp'

const SOURCE = new URL('../icon/tmodmanager-icon.png', import.meta.url).pathname
const OUT = new URL('../public/', import.meta.url)
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 }

/** Icona per la home screen: sfondo bianco al posto della trasparenza. */
const opaque = (size) =>
  sharp(SOURCE).resize(size, size, { kernel: 'lanczos3' }).flatten({ background: WHITE }).png({ compressionLevel: 9 })

// Il disegno sta già dentro la "safe zone" delle icone maskable (cerchio con diametro 80%),
// quindi la versione maskable usa la stessa immagine senza margini aggiuntivi.
const opaqueIcons = {
  'pwa-192x192.png': 192,
  'pwa-512x512.png': 512,
  'maskable-192x192.png': 192,
  'maskable-512x512.png': 512,
  'apple-touch-icon.png': 180,
}
for (const [name, size] of Object.entries(opaqueIcons)) {
  await opaque(size).toFile(new URL(name, OUT).pathname)
}

// Favicon della scheda: trasparente e ritagliata sul disegno, così a 16/32 px resta leggibile.
const trimmed = await sharp(SOURCE).trim().png().toBuffer()
const faviconPng = (size) =>
  sharp(trimmed)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toBuffer()

await sharp(await faviconPng(96)).toFile(new URL('favicon-96x96.png', OUT).pathname)

// favicon.ico con PNG da 16, 32 e 48 px incorporati.
const sizes = [16, 32, 48]
const images = await Promise.all(sizes.map(faviconPng))
const header = Buffer.alloc(6 + 16 * sizes.length)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2) // tipo: icona
header.writeUInt16LE(sizes.length, 4)
let offset = header.length
sizes.forEach((size, i) => {
  const entry = 6 + 16 * i
  header.writeUInt8(size, entry)
  header.writeUInt8(size, entry + 1)
  header.writeUInt16LE(1, entry + 4) // piani di colore
  header.writeUInt16LE(32, entry + 6) // bit per pixel
  header.writeUInt32LE(images[i].length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += images[i].length
})
await writeFile(new URL('favicon.ico', OUT), Buffer.concat([header, ...images]))

console.log('Icone generate in public/')

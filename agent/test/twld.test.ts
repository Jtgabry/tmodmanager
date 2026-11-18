import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { fallbackColor, modBlockColors } from '../src/modMapColors.ts'
import { rawimgAverageColor } from '../src/tmod.ts'
import { LAYER, overlayModBlocks, readModBlocks } from '../src/twld.ts'

// --- Scrittura TagIO minima (big-endian, stringhe con lunghezza int16), come tModLoader ---------------

const str = (s: string) => {
  const b = Buffer.from(s, 'utf8')
  const len = Buffer.alloc(2)
  len.writeInt16BE(b.length)
  return Buffer.concat([len, b])
}
const i32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeInt32BE(n)
  return b
}
const named = (type: number, name: string, payload: Buffer) => Buffer.concat([Buffer.from([type]), str(name), payload])
const compound = (...tags: Buffer[]) => Buffer.concat([...tags, Buffer.from([0])])
const list = (type: number, items: Buffer[]) => Buffer.concat([Buffer.from([type]), i32(items.length), ...items])
const entry = (value: number, mod: string, name: string, framed?: boolean) =>
  compound(
    named(8, '<type>', str('Terraria.ModLoader.IO.TileEntry')),
    named(2, 'value', Buffer.from([value >> 8, value & 0xff])),
    named(8, 'mod', str(mod)),
    named(8, 'name', str(name)),
    ...(framed === undefined ? [] : [named(1, 'framed', Buffer.from([framed ? 1 : 0]))]),
  )
const bytes = (b: Buffer) => Buffer.concat([i32(b.length), b])

/** Dati per tile, colonna per colonna: uint16 LE id (0 = niente), poi vernice e frame (4 byte) se framed. */
function blockData(width: number, height: number, at: (x: number, y: number) => number, framed: Set<number> = new Set()) {
  const parts: number[] = []
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const v = at(x, y)
      parts.push(v & 0xff, v >> 8)
      if (v) {
        parts.push(0)
        if (framed.has(v)) parts.push(0, 0, 0, 0)
      }
    }
  }
  return Buffer.from(parts)
}

const W = 4
const H = 3

function fakeTwld() {
  // Blocco della mod (framed) in (1, 2), blocco non framed in (3, 0); muro della mod su tutta la colonna x=0
  const tileData = blockData(W, H, (x, y) => (x === 1 && y === 2 ? 900 : x === 3 && y === 0 ? 901 : 0), new Set([900]))
  const wallData = blockData(W, H, (x) => (x === 0 ? 400 : 0))
  const root = compound(
    named(10, '0header', compound(named(8, 'note', str('ignorato')))),
    named(
      10,
      'tiles',
      compound(
        named(9, 'tileMap', list(10, [entry(900, 'Calamity', 'Gravel', true), entry(901, 'Calamity', 'Crystal', false)])),
        named(7, 'tileData', bytes(tileData)),
        named(9, 'wallMap', list(10, [entry(400, 'Calamity', 'SlabWall')])),
        named(7, 'wallData', bytes(wallData)),
      ),
    ),
    named(11, 'ints', Buffer.concat([i32(2), i32(1), i32(2)])),
  )
  return gzipSync(named(10, '', root.subarray(0)))
}

test('.twld: blocchi e muri delle mod letti dal TagCompound e disegnati sopra la mappa vanilla', () => {
  const blocks = readModBlocks(fakeTwld())
  assert.ok(blocks)
  assert.deepEqual(
    blocks.tiles.map((e) => [e.value, e.mod, e.name, e.framed]),
    [
      [900, 'Calamity', 'Gravel', true],
      [901, 'Calamity', 'Crystal', false],
    ],
  )

  // Mappa vanilla 4×3: sfondo, tranne un liquido in (0, 1)
  const pixels = new Uint32Array(W * H).fill(0x111111)
  const layers = new Uint8Array(W * H)
  pixels[1 * W + 0] = 0x0000ff
  layers[1 * W + 0] = LAYER.liquid
  const colors: Record<string, number> = { Gravel: 0xaa0000, Crystal: 0x00aa00, SlabWall: 0x333333 }
  overlayModBlocks(pixels, layers, W, H, blocks, (e) => colors[e.name])

  const at = (x: number, y: number) => pixels[y * W + x]
  assert.equal(at(1, 2), 0xaa0000) // blocco framed: i 4 byte di frame non spostano la lettura
  assert.equal(at(3, 0), 0x00aa00)
  assert.equal(at(0, 0), 0x333333) // muro della mod sullo sfondo
  assert.equal(at(0, 1), 0x0000ff) // ...ma non sopra il liquido
  assert.equal(at(2, 1), 0x111111)

  assert.throws(() => readModBlocks(Buffer.from('non gzip')))
})

test('colori dei blocchi delle mod: media della texture rawimg, altrimenti un colore stabile dal nome', async () => {
  // rawimg 2×2: tre pixel opachi (rosso, rosso, blu) e uno trasparente
  const img = Buffer.alloc(12 + 16)
  img.writeInt32LE(1, 0)
  img.writeInt32LE(2, 4)
  img.writeInt32LE(2, 8)
  Buffer.from([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 9, 9, 9, 0]).copy(img, 12)
  assert.equal(rawimgAverageColor(img), (170 << 16) | 85)
  assert.equal(rawimgAverageColor(Buffer.from('rotto')), null)

  // Mod non installata: colore dal nome, sempre lo stesso
  const dir = await mkdtemp(join(tmpdir(), 'tmm-modcolors-'))
  const tile = { value: 900, mod: 'Sparita', name: 'Blocco', framed: false }
  const { colorOf, fromTextures } = await modBlockColors([tile], [], join(dir, 'Mods'), join(dir, 'mod-colors.json'))
  assert.equal(fromTextures, 0)
  assert.equal(colorOf(tile, false), fallbackColor('Sparita/Blocco'))
  assert.notEqual(fallbackColor('Sparita/Blocco'), fallbackColor('Sparita/Altro'))
})

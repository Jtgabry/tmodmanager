import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { config } from '../src/config.ts'
import { spritePng, vanillaAssets } from '../src/mapSprites.ts'
import { ServerDefinition } from '../src/registry.ts'
import { readXnbTexture } from '../src/xnb.ts'

const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}
const str = (s: string) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s)])

/** Contenuto di un .xnb con una Texture2D (formato Color) 2×1: un pixel rosso opaco, uno rosso a metà alfa (premoltiplicato). */
const payload = Buffer.concat([
  Buffer.from([1]), str('Microsoft.Xna.Framework.Content.Texture2DReader, Microsoft.Xna.Framework.Graphics'), u32(0),
  Buffer.from([0]), Buffer.from([1]),
  u32(0), u32(2), u32(1), u32(1), u32(8), Buffer.from([255, 0, 0, 255, 64, 0, 0, 128]),
])

const xnb = (flags: number, body: Buffer, extra: Buffer[] = []) =>
  Buffer.concat([Buffer.from('XNBw'), Buffer.from([5, flags]), u32(10 + body.length + extra.reduce((s, e) => s + e.length, 0)), ...extra, body])

/** Flusso LZX con un solo blocco "non compresso" (tipo 3): bit d'intestazione in parole da 16 bit, poi i byte così come sono. */
function lzxStored(data: Buffer) {
  const bits: number[] = [0, 0, 1, 1] // niente traduzione E8, tipo 3
  for (let i = 15; i >= 0; i--) bits.push(((data.length >> 8) >> i) & 1) // lunghezza: 16 bit alti…
  for (let i = 7; i >= 0; i--) bits.push((data.length >> i) & 1) // …e 8 bassi
  while (bits.length % 16) bits.push(0) // allineamento prima dei dati
  const words: number[] = []
  for (let i = 0; i < bits.length; i += 16) words.push(parseInt(bits.slice(i, i + 16).join(''), 2))
  const header = Buffer.alloc(words.length * 2)
  words.forEach((w, i) => header.writeUInt16LE(w, i * 2))
  return Buffer.concat([header, u32(1), u32(1), u32(1), data, data.length & 1 ? Buffer.from([0]) : Buffer.alloc(0)])
}

test('.xnb: texture non compressa e compressa LZX, alfa riportato come nei PNG', () => {
  for (const file of [
    xnb(0, payload),
    (() => {
      const lzx = lzxStored(payload)
      const chunk = Buffer.concat([Buffer.from([0xff, payload.length >> 8, payload.length & 0xff, lzx.length >> 8, lzx.length & 0xff]), lzx])
      return xnb(0x80, chunk, [u32(payload.length)])
    })(),
  ]) {
    const texture = readXnbTexture(file)
    assert.deepEqual([texture.width, texture.height], [2, 1])
    assert.deepEqual([...texture.rgba], [255, 0, 0, 255, 128, 0, 0, 128])
  }
  assert.throws(() => readXnbTexture(Buffer.from('non un xnb')), /Non è un file .xnb/)
})

test('sprite di Terraria: dalle texture del gioco in terraria-assets, anche per le mod che le usano', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tmm-vanilla-'))
  config.dataDir = join(root, 'data')
  assert.equal(await vanillaAssets(), null)
  const images = join(config.dataDir, 'terraria-assets', '1.4.5.8', 'Images')
  await mkdir(images, { recursive: true })
  await writeFile(join(images, 'Tiles_0.xnb'), xnb(0, payload))
  await writeFile(join(images, 'Tiles_1.xnb'), xnb(0, payload))
  assert.equal((await vanillaAssets())?.version, '1.4.5.8')

  const server = ServerDefinition.parse({ id: 'v', name: 'V', game: 'tshock', installDir: join(root, 'i'), saveDir: join(root, 'save'), configFile: join(root, 'c.txt') })
  const typesPath = join(root, 'types.json')
  await writeFile(
    typesPath,
    JSON.stringify({
      format: 2, vanillaTiles: 693, vanillaWalls: 347, frameImportant: [], solid: [],
      modTiles: { '700': { mod: 'Foo', name: 'Pietra', texture: 'Terraria/Images/Tiles_1' } }, modWalls: {},
    }),
  )
  const png = await spritePng(server, typesPath, 'tiles', 1)
  assert.equal(png, join(config.dataDir, 'terraria-assets', '1.4.5.8', 'png', 'Tiles_1.png'))
  assert.equal((await readFile(png!)).toString('latin1', 1, 4), 'PNG')
  assert.equal(await spritePng(server, typesPath, 'tiles', 700), png) // blocco di una mod con la texture di Terraria
  assert.equal(await spritePng(server, typesPath, 'tiles', 2), null) // texture non copiata
  assert.equal(await spritePng(server, typesPath, 'walls', 1), null)

  // Chiome e rami degli alberi: texture a parte, per stile
  await writeFile(join(images, 'Tree_Tops_2.xnb'), xnb(0, payload))
  assert.equal(await spritePng(server, typesPath, 'treetops', 2), join(config.dataDir, 'terraria-assets', '1.4.5.8', 'png', 'Tree_Tops_2.png'))
  assert.equal(await spritePng(server, typesPath, 'treebranches', 2), null)
})

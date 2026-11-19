import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { inflateSync } from 'node:zlib'
import { config } from '../src/config.ts'
import { parseTexture, rawimgToPng, spritePng } from '../src/mapSprites.ts'
import { ServerDefinition } from '../src/registry.ts'
import { mapTilesPath, mapTypesPath, worldMap } from '../src/worldMap.ts'

const str = (s: string) => {
  const b = Buffer.from(s, 'utf8')
  return Buffer.concat([Buffer.from([b.length]), b])
}
const i32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeInt32LE(n)
  return b
}

/** .tmod con i file indicati (non compressi). */
function tmod(name: string, files: { path: string; data: Buffer }[]) {
  return Buffer.concat([
    Buffer.from('TMOD'), str('2026.8.3.0'), Buffer.alloc(20), Buffer.alloc(256), Buffer.alloc(4),
    str(name), str('1.0'), i32(files.length),
    ...files.flatMap((f) => [str(f.path), i32(f.data.length), i32(f.data.length)]),
    ...files.map((f) => f.data),
  ])
}

/** rawimg 2×1: un pixel rosso opaco, uno trasparente. */
const rawimg = Buffer.concat([i32(1), i32(2), i32(1), Buffer.from([255, 0, 0, 255, 0, 0, 0, 0])])

test('texture delle mod: percorso nel .tmod, mai quelle di Terraria né percorsi strani', () => {
  assert.deepEqual(parseTexture('CalamityMod/Tiles/Abyss/AbyssGravel'), { mod: 'CalamityMod', path: 'Tiles/Abyss/AbyssGravel' })
  assert.equal(parseTexture('Terraria/Images/Tiles_1'), null)
  assert.equal(parseTexture('CalamityMod/../x'), null)
  assert.equal(parseTexture('/etc/passwd'), null)
  assert.equal(parseTexture('Solo'), null)
})

test('rawimg → PNG RGBA', () => {
  const png = rawimgToPng(rawimg)!
  assert.equal(png.toString('latin1', 1, 4), 'PNG')
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]], [2, 1, 8, 6])
  // IDAT: filtro 0, poi i pixel così come sono (con la trasparenza)
  const idat = png.indexOf('IDAT')
  const data = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)))
  assert.deepEqual([...data], [0, 255, 0, 0, 255, 0, 0, 0, 0])
  assert.equal(rawimgToPng(Buffer.from('rotto')), null)
})

test('sprite di un blocco di una mod: dal .tmod della mod, convertito una volta e tenuto da parte', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tmm-sprites-'))
  config.dataDir = join(root, 'data')
  const server = ServerDefinition.parse({ id: 's', name: 'S', game: 'tmodloader', installDir: join(root, 'i'), saveDir: join(root, 'save'), configFile: join(root, 'c.txt') })
  const mods = join(server.saveDir, 'Mods')
  await mkdir(mods, { recursive: true })
  await writeFile(join(mods, 'Foo.tmod'), tmod('Foo', [{ path: 'Tiles/Bar.rawimg', data: rawimg }]))
  const dir = join(server.saveDir, 'LiveMap')
  await mkdir(join(dir, 'tiles'), { recursive: true })
  const types = {
    format: 1, vanillaTiles: 693, vanillaWalls: 347, frameImportant: [], solid: [],
    modTiles: { '700': { mod: 'Foo', name: 'Bar', texture: 'Foo/Tiles/Bar' }, '701': { mod: 'Foo', name: 'Altro', texture: 'Terraria/Images/Tiles_1' } },
    modWalls: {},
  }
  await writeFile(join(dir, 'types.json'), JSON.stringify(types))

  const path = await spritePng(server, mapTypesPath(server, 'livemap')!, 'tiles', 700)
  assert.ok(path?.startsWith(join(config.dataDir, 'servers', 's', 'sprites', 'Foo', '1.0')))
  assert.equal((await readFile(path!)).toString('latin1', 1, 4), 'PNG')
  assert.equal(await spritePng(server, mapTypesPath(server, 'livemap')!, 'tiles', 701), null) // texture di Terraria
  assert.equal(await spritePng(server, mapTypesPath(server, 'livemap')!, 'tiles', 1), null) // blocco di Terraria
  assert.equal(await spritePng(server, mapTypesPath(server, 'livemap')!, 'walls', 700), null)

  // Riquadri con i dati delle tile e versione dei tipi nello stato della mappa
  await writeFile(join(mods, 'enabled.json'), '["TmmLiveMap"]')
  await writeFile(join(mods, 'TmmLiveMap.tmod'), tmod('TmmLiveMap', []))
  config.addonsDir = join(root, 'addons')
  await writeFile(join(dir, 'tiles', '0_0.bin'), 'x')
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      format: 1, world: { name: 'P', id: 1, width: 200, height: 150, spawnX: 100, spawnY: 50, surface: 60, rock: 90 },
      chunkWidth: 200, chunkHeight: 150, cols: 1, rows: 1, chunks: [1], hashes: ['1'],
      overview: { scale: 4, width: 50, height: 38, version: 1 }, progress: { drawn: 1, total: 1 }, tileData: 1,
    }),
  )
  const state = await worldMap(server)
  assert.equal(state.source, 'livemap')
  assert.equal(state.manifest?.tileData, 1)
  assert.ok((state.typesVersion ?? 0) > 0)
  assert.ok(await mapTilesPath(server, 'livemap', '0', '0'))
  assert.equal(await mapTilesPath(server, 'world', '0', '0'), null)
  assert.equal(await mapTilesPath(server, 'livemap', '../0', '0'), null)
})

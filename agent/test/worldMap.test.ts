import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { test } from 'node:test'
import { config } from '../src/config.ts'
import { ServerDefinition } from '../src/registry.ts'
import { type MapColors, readWorldHeader, renderWorld } from '../src/worldFile.ts'
import { worldFileMapIdle } from '../src/worldFileMap.ts'
import { renderWorldFile } from '../src/worldFileRender.ts'
import { mapChunkPath, mapOverviewPath, worldMap } from '../src/worldMap.ts'

const WIDTH = 240
const HEIGHT = 300

/** Tabelle dei colori minime: 0 = terra, 1 = pietra; muro 1; liquidi; sfondi con 2 sfumature. */
const COLORS: MapColors = {
  format: 1,
  terraria: '1.4.5.8',
  // 0 (vuoto) · terra · pietra · muro · acqua, lava, miele, shimmer · cielo×2 · terra×2 · roccia×2 · inferi
  colors: [0, 0x976b4b, 0x808080, 0x584426, 0x093dbf, 0xfd2003, 0xfe9e23, 0xe0a0ff, 0x3228ff, 0x3a64ff, 0x543b26, 0x473221, 0x4a433c, 0x3d3833, 0x322c26],
  tileLookup: [1, 2],
  tileOptionCounts: [1, 1],
  wallLookup: [0, 3],
  wallOptionCounts: [0, 1],
  liquidPosition: 4,
  skyPosition: 8,
  dirtPosition: 10,
  rockPosition: 12,
  hellPosition: 14,
  maxSkyGradients: 2,
  maxDirtGradients: 2,
  maxRockGradients: 2,
}

const string = (s: string) => Buffer.concat([Buffer.from([Buffer.byteLength(s)]), Buffer.from(s)])
const int32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeInt32LE(n)
  return b
}
const int16 = (n: number) => {
  const b = Buffer.alloc(2)
  b.writeInt16LE(n)
  return b
}
const double = (n: number) => {
  const b = Buffer.alloc(8)
  b.writeDoubleLE(n)
  return b
}

/**
 * Mondo .wld minimo (versione 279): colonne vuote, tranne la x=10 (terra da y=100 in giù) e la x=20
 * (muro e acqua). Spawn e livelli dopo qualche campo qualsiasi, come nei file veri.
 */
function fakeWorld(name: string) {
  const header = Buffer.concat([
    string(name), string('seme'), Buffer.alloc(8), Buffer.alloc(16), int32(7), Buffer.alloc(16), int32(HEIGHT), int32(WIDTH),
    Buffer.from([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), // campi variabili
    int32(120), int32(90), double(110), double(160),
  ])
  const columns: Buffer[] = []
  const run = (h1: number, data: number[], count: number) => Buffer.concat([Buffer.from([h1 | 0x80, ...data]), int16(count)])
  for (let x = 0; x < WIDTH; x++) {
    if (x === 10) columns.push(run(0, [], 99), run(2, [0], HEIGHT - 101)) // aria, poi terra (tipo 0)
    else if (x === 20) columns.push(run(4 | 8, [1, 255], HEIGHT - 1)) // muro 1 + acqua
    else columns.push(run(0, [], HEIGHT - 1))
  }
  const tiles = Buffer.concat(columns)
  const fileHeader = (h: number, t: number) =>
    Buffer.concat([int32(279), Buffer.from('relogic'), Buffer.from([2]), Buffer.alloc(12), int16(2), int32(h), int32(t), int16(2), Buffer.from([0])])
  const headerAt = fileHeader(0, 0).length
  return Buffer.concat([fileHeader(headerAt, headerAt + header.length), header, tiles])
}

async function setup(game: 'tshock' | 'terraria') {
  config.dataDir = await mkdtemp(join(tmpdir(), 'tmm-map-'))
  config.addonsDir = join(config.dataDir, 'addons')
  await mkdir(config.addonsDir, { recursive: true })
  await writeFile(join(config.addonsDir, 'LiveMap.dll'), 'dll')
  await writeFile(join(config.addonsDir, 'map-colors.json'), JSON.stringify(COLORS))
  const save = join(config.dataDir, 'servers', 'm', 'save')
  const configFile = join(config.dataDir, 'servers', 'm', 'serverconfig.txt')
  await mkdir(join(save, 'Worlds'), { recursive: true })
  await writeFile(configFile, `world=${join(save, 'Worlds', 'Prova.wld')}\n`)
  const server = ServerDefinition.parse({ id: 'm', name: 'M', game, installDir: join(config.dataDir, 'i'), saveDir: save, configFile })
  const writeWorld = async () => {
    const path = join(save, 'Worlds', 'Prova.wld')
    await writeFile(path, fakeWorld('Prova'))
    // Salvato "un po' fa": un file appena scritto potrebbe essere ancora in scrittura
    const past = new Date(Date.now() - 60_000)
    await utimes(path, past, past)
  }
  return { server, save, writeWorld, liveMap: join(save, 'tshock', 'map'), plugins: join(save, 'ServerPlugins') }
}

test('lettura del .wld: intestazione, spawn e livelli, colori di blocchi, muri, liquidi e sfondo', () => {
  const buf = fakeWorld('Prova')
  const header = readWorldHeader(buf)
  assert.deepEqual(
    [header.name, header.id, header.width, header.height, header.spawnX, header.spawnY, header.surface, header.rock],
    ['Prova', 7, WIDTH, HEIGHT, 120, 90, 110, 160],
  )
  const { pixels: px, layers } = renderWorld(buf, header, COLORS)
  const at = (x: number, y: number) => px[y * WIDTH + x]
  assert.equal(at(10, 150), 0x976b4b) // terra
  assert.equal(at(20, 50), 0x093dbf) // l'acqua copre il muro
  assert.equal(at(0, 0), 0x3228ff) // cielo in alto
  assert.equal(at(0, 100), 0x3a64ff) // cielo più chiaro verso la superficie
  assert.equal(at(0, 299), 0x322c26) // inferi
  assert.deepEqual([layers[150 * WIDTH + 10], layers[50 * WIDTH + 20], layers[0]], [3, 2, 0])
  assert.throws(() => readWorldHeader(Buffer.from('non un mondo, decisamente non un mondo')))
})

test('mappa dal file del mondo per un server vanilla: disegnata in un worker, si ridisegna quando il mondo cambia', async () => {
  const { server, writeWorld } = await setup('terraria')
  assert.equal((await worldMap(server)).unavailable, 'no-world')

  await writeWorld()
  const first = await worldMap(server)
  assert.deepEqual([first.unavailable, first.worldFile?.generating], ['loading', true])
  await worldFileMapIdle()

  const state = await worldMap(server)
  assert.equal(state.source, 'world')
  assert.equal(state.worldFile?.generating, false)
  assert.deepEqual([state.manifest?.world.name, state.manifest?.cols, state.manifest?.rows], ['Prova', 2, 2])
  const chunk = await mapChunkPath(server, 'world', '0', '0')
  assert.ok(chunk)
  assert.equal((await readFile(chunk)).toString('latin1', 1, 4), 'PNG')
  assert.ok(await mapOverviewPath(server, 'world'))
  assert.equal(await mapChunkPath(server, 'livemap', '0', '0'), null)

  // Dati grezzi delle tile per gli sprite (senza LiveMap): stesso formato, frame da calcolare (-1, muri 0xFF)
  assert.equal(state.manifest?.tileData, 2)
  assert.ok((state.typesVersion ?? 0) > 0)
  const tiles = gunzipSync(await readFile(join(config.dataDir, 'servers', 'm', 'worldmap', 'tiles', '0_1.bin')))
  assert.deepEqual([tiles.toString('latin1', 0, 4), tiles[4], tiles[5], tiles.readUInt16LE(6), tiles.readUInt16LE(8)], ['TMMT', 2, 12, 200, 150])
  const at = (x: number, y: number) => 10 + ((y - 150) * 200 + x) * 12
  assert.deepEqual([tiles.readUInt16LE(at(10, 160)), tiles.readInt16LE(at(10, 160) + 2), tiles[at(10, 160) + 10]], [0, -1, 0xff]) // terra
  assert.deepEqual([tiles.readUInt16LE(at(20, 160)), tiles.readUInt16LE(at(20, 160) + 6), tiles[at(20, 160) + 8] & 0x10], [0xffff, 1, 0x10]) // muro e acqua
  const types = JSON.parse(await readFile(join(config.dataDir, 'servers', 'm', 'worldmap', 'types.json'), 'utf8'))
  assert.deepEqual([types.format, types.vanillaTiles, types.vanillaWalls], [2, 2, 2])

  // Stesso file: niente da rifare; mondo salvato di nuovo: si ridisegna, i riquadri uguali tengono la versione
  assert.equal((await worldMap(server)).worldFile?.generating, false)
  const versions = state.manifest!.chunks
  await writeWorld()
  assert.equal((await worldMap(server)).worldFile?.generating, true)
  await worldFileMapIdle()
  assert.deepEqual((await worldMap(server)).manifest?.chunks, versions)
})

test('server TShock: LiveMap ha la precedenza quando ha disegnato, altrimenti la mappa dal file', async () => {
  const { server, writeWorld, liveMap, plugins } = await setup('tshock')
  await writeWorld()
  await worldMap(server)
  await worldFileMapIdle()

  const off = await worldMap(server, { watching: true })
  assert.deepEqual([off.source, off.liveMap], ['world', { available: true, installed: true, enabled: false }])
  await assert.rejects(stat(join(liveMap, 'viewer'))) // LiveMap spento: nessun segnale

  await mkdir(plugins, { recursive: true })
  await writeFile(join(plugins, 'LiveMap.dll'), 'dll')
  const waiting = await worldMap(server, { watching: true })
  assert.equal(waiting.source, 'world') // LiveMap non ha ancora disegnato
  assert.ok((await stat(join(liveMap, 'viewer'))).mtimeMs > Date.now() - 5000)

  await writeFile(
    join(liveMap, 'manifest.json'),
    JSON.stringify({
      format: 1,
      world: { name: 'Prova', id: 7, width: WIDTH, height: HEIGHT, spawnX: 120, spawnY: 90, surface: 110, rock: 160 },
      chunkWidth: 200, chunkHeight: 150, cols: 2, rows: 2, chunks: [1, 0, 0, 0], hashes: [],
      overview: { scale: 4, width: 60, height: 75, version: 0 },
      progress: { drawn: 1, total: 4 },
    }),
  )
  await writeFile(join(liveMap, 'players.json'), JSON.stringify({ players: [{ name: 'Ana', x: 120, y: 88, team: 1, life: 100, lifeMax: 100, dead: false }] }))
  const live = await worldMap(server, { watching: true })
  assert.equal(live.source, 'livemap')
  assert.deepEqual(live.players.map((p) => p.name), ['Ana'])
  assert.equal('hashes' in (live.manifest ?? {}), false)
  assert.equal(await mapChunkPath(server, 'livemap', '../x', '1'), null)
})

// Lo strumento lo compila addons/build.sh (nella CI prima dei test); senza, il test si salta
const WORLD_FRAMES = join(import.meta.dirname, '..', '..', 'addons', 'dist', 'WorldFrames', 'WorldFrames.dll')
const DOTNET = process.env.AGENT_DOTNET || (existsSync(join(process.env.HOME ?? '', '.dotnet', 'dotnet')) ? join(process.env.HOME ?? '', '.dotnet', 'dotnet') : 'dotnet')

test('frame delle tile calcolati con il codice di Terraria (WorldFrames), e non ricalcolati se il mondo non cambia', { skip: !existsSync(WORLD_FRAMES) }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmm-frames-'))
  const world = join(dir, 'Prova.wld')
  await writeFile(world, fakeWorld('Prova'))
  const colors = join(dir, 'colors.json')
  await writeFile(colors, JSON.stringify(COLORS))
  const out = join(dir, 'map')
  const job = { worldPath: world, source: { file: 'Prova.wld', mtimeMs: 1, size: 1 }, outDir: out, colorsPath: colors, frames: { dotnet: DOTNET, dll: WORLD_FRAMES } }
  await renderWorldFile(job)
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'))
  assert.deepEqual([manifest.framed, manifest.frameError], [true, null])
  const tiles = gunzipSync(await readFile(join(out, 'tiles', '0_1.bin')))
  const at = (x: number, y: number) => 10 + ((y - 150) * 200 + x) * 12
  // Colonna di terra larga una tile: il gioco le dà un frame (non più -1), e al muro il suo
  assert.ok(tiles.readInt16LE(at(10, 160) + 2) >= 0)
  assert.notEqual(tiles[at(20, 160) + 10], 0xff)

  await renderWorldFile(job)
  assert.deepEqual(JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')).chunks, manifest.chunks)
})

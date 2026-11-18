import assert from 'node:assert/strict'
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { config } from '../src/config.ts'
import { ServerDefinition } from '../src/registry.ts'
import { mapChunkPath, mapOverviewPath, worldMap } from '../src/worldMap.ts'

const MANIFEST = {
  format: 1,
  world: { name: 'Mondo', id: 42, width: 4200, height: 1200, spawnX: 2100, spawnY: 300, surface: 350, rock: 500 },
  chunkWidth: 200,
  chunkHeight: 150,
  cols: 21,
  rows: 8,
  chunks: Array(168).fill(0),
  hashes: ['ignorati'],
  overview: { scale: 4, width: 1050, height: 300, version: 0 },
  progress: { drawn: 3, total: 168 },
}

async function setup(game: 'tshock' | 'terraria') {
  const dir = await mkdtemp(join(tmpdir(), 'tmm-map-'))
  config.addonsDir = join(dir, 'addons')
  await mkdir(config.addonsDir, { recursive: true })
  await writeFile(join(config.addonsDir, 'LiveMap.dll'), 'dll')
  const server = ServerDefinition.parse({ id: 'm', name: 'M', game, installDir: join(dir, 'i'), saveDir: join(dir, 's'), configFile: join(dir, 'c.txt') })
  return { server, map: join(dir, 's', 'tshock', 'map'), plugins: join(dir, 's', 'ServerPlugins') }
}

test('mappa del mondo: motivi per cui non c\'è, add-on attivo, dati di LiveMap e segnale "qualcuno guarda"', async () => {
  const vanilla = await setup('terraria')
  assert.equal((await worldMap(vanilla.server)).unavailable, 'unsupported-game')

  const { server, map, plugins } = await setup('tshock')
  assert.deepEqual(await worldMap(server), {
    source: null, unavailable: 'addon-disabled', liveMap: { available: true, enabled: false }, updatedAt: null, manifest: null, players: [], playersAt: null,
  })

  await mkdir(plugins, { recursive: true })
  await writeFile(join(plugins, 'LiveMap.dll'), 'dll')
  assert.equal((await worldMap(server)).unavailable, 'no-data')
  // Senza la pagina aperta il plugin non viene svegliato
  await assert.rejects(stat(join(map, 'viewer')))
  await worldMap(server, { watching: true })
  assert.ok((await stat(join(map, 'viewer'))).mtimeMs > Date.now() - 5000)

  await mkdir(join(map, 'chunks'), { recursive: true })
  await writeFile(join(map, 'manifest.json'), JSON.stringify(MANIFEST))
  await writeFile(join(map, 'players.json'), JSON.stringify({ players: [{ name: 'Ana', x: 2100.5, y: 290, team: 0, life: 100, lifeMax: 100, dead: false }] }))
  await writeFile(join(map, 'chunks', '3_1.png'), 'png')
  const state = await worldMap(server)
  assert.equal(state.source, 'livemap')
  assert.equal(state.manifest?.world.name, 'Mondo')
  assert.equal('hashes' in (state.manifest ?? {}), false)
  assert.deepEqual(state.players.map((p) => p.name), ['Ana'])

  assert.equal(await mapChunkPath(server, '3', '1'), join(map, 'chunks', '3_1.png'))
  assert.equal(await mapChunkPath(server, '../x', '1'), null)
  assert.equal(await mapChunkPath(server, '4', '1'), null)
  assert.equal(await mapOverviewPath(server), null)
})

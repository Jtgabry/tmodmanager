import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { config } from '../src/config.ts'
import { refreshInstalledModAddons } from '../src/modAddons.ts'
import { exportModpackZip } from '../src/modpackExport.ts'
import { createModpack, listModpacks } from '../src/modpacks.ts'
import { listMods } from '../src/mods.ts'
import { ServerDefinition } from '../src/registry.ts'
import { readModInfo } from '../src/tmod.ts'
import { browseWorkshop, checkUpdates, pendingMods, setLink, startInstall, startInstallByName, startUpdate, workshopItemDetails } from '../src/workshop.ts'
import { worldMap } from '../src/worldMap.ts'

const VERSION_FILE = '.tmodmanager-version'

const str = (s: string) => {
  const b = Buffer.from(s, 'utf8')
  return Buffer.concat([Buffer.from([b.length]), b])
}
const i32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeInt32LE(n)
  return b
}

/** .tmod con un file Info (nome visibile, descrizione, lato server), come quelli di addons/build.sh. */
function tmod(name: string, version: string, tml = '2026.8.3.0') {
  const info = Buffer.concat([
    str('author'), str('tModManager'), str('version'), str(version), str('displayName'), str('LiveMap'),
    str('description'), str('Mappa del mondo in tempo reale per il pannello.'), str('side'), Buffer.from([2]), str(''),
  ])
  const files = [{ path: 'Info', data: info }]
  return Buffer.concat([
    Buffer.from('TMOD'), str(tml), Buffer.alloc(20), Buffer.alloc(256), Buffer.alloc(4),
    str(name), str(version), i32(files.length),
    ...files.flatMap((f) => [str(f.path), i32(f.data.length), i32(f.data.length)]),
    ...files.map((f) => f.data),
  ])
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'tmm-addon-'))
  config.dataDir = join(root, 'data')
  config.addonsDir = join(root, 'addons')
  config.steamApiKey = ''
  await mkdir(config.addonsDir, { recursive: true })
  await writeFile(join(config.addonsDir, 'TmmLiveMap.tmod'), tmod('TmmLiveMap', '1.0'))
  const install = join(root, 'tml')
  await mkdir(install, { recursive: true })
  const server = ServerDefinition.parse({ id: 'tml', name: 'T', game: 'tmodloader', installDir: install, saveDir: join(root, 'save'), configFile: join(root, 'serverconfig.txt') })
  await mkdir(join(server.saveDir, 'Mods'), { recursive: true })
  return { root, server, mods: join(server.saveDir, 'Mods') }
}

test('LiveMap nel Workshop del pannello: c\'è anche senza Steam, e si installa come una mod scaricata', async () => {
  const { server, mods } = await setup()

  const page = await browseWorkshop(server, {})
  assert.deepEqual(page.items.map((i) => [i.id, i.title, i.modName, i.addon, i.compatibleVersion]), [['tmm-TmmLiveMap', 'LiveMap', 'TmmLiveMap', true, '1.0']])
  assert.match(page.steamError ?? '', /STEAM_API_KEY/)
  assert.equal((await browseWorkshop(server, { q: 'mappa' })).items.length, 1)
  assert.equal((await browseWorkshop(server, { q: 'calamity' })).items.length, 0)
  assert.equal((await browseWorkshop(server, { tag: 'library' })).items.length, 0)
  assert.equal((await workshopItemDetails(server, 'tmm-TmmLiveMap')).description, 'Mappa del mondo in tempo reale per il pannello.')

  // "Installa": copiata in Mods/, disabilitata, in attesa di essere abilitata (come quelle scaricate da Steam)
  const job = await startInstall(server, ['tmm-TmmLiveMap'])
  assert.deepEqual([job.state, job.items.map((i) => [i.name, i.state, i.install])], ['done', [['TmmLiveMap', 'done', true]]])
  const mod = (await listMods(server)).mods.find((m) => m.name === 'TmmLiveMap')
  assert.deepEqual([mod?.addon, mod?.enabled, mod?.displayName], [true, false, 'LiveMap'])
  assert.deepEqual((await pendingMods(server)).map((m) => m.name), ['TmmLiveMap'])
  assert.equal((await startInstall(server, ['tmm-TmmLiveMap'])).items[0].state, 'skipped')
  assert.equal((await startInstallByName(server, ['TmmLiveMap'])).items[0].state, 'skipped')

  // Mai collegata allo Steam Workshop
  assert.equal((await checkUpdates(server)).mods.some((m) => m.name === 'TmmLiveMap'), false)
  await assert.rejects(setLink(server, 'TmmLiveMap', '123'), /add-on di tModManager/)
  await assert.rejects(startUpdate(server, ['TmmLiveMap']), /add-on di tModManager/)

  // Si aggiorna con il pannello: la copia nel server viene sostituita, niente archivio delle versioni
  await writeFile(join(config.addonsDir, 'TmmLiveMap.tmod'), tmod('TmmLiveMap', '1.1'))
  assert.deepEqual(await refreshInstalledModAddons(server), ['TmmLiveMap'])
  assert.equal((await readModInfo(join(mods, 'TmmLiveMap.tmod'))).version, '1.1')
  assert.deepEqual(await refreshInstalledModAddons(server), [])
  assert.deepEqual((await readdir(mods)).sort(), ['TmmLiveMap.tmod'])
})

test('server con tModLoader più vecchio di quella per cui è compilata: LiveMap si vede ma non si installa', async () => {
  const { server } = await setup()
  await writeFile(join(server.installDir, VERSION_FILE), '2026.7.3.0\n')
  const [item] = (await browseWorkshop(server, {})).items
  assert.deepEqual([item.compatibleVersion, item.requiresTml], [null, '2026.8.3.0'])
  await assert.rejects(startInstall(server, ['tmm-TmmLiveMap']), /richiede tModLoader 2026\.8\.3\.0/)
})

test('esportazione dei modpack: LiveMap resta sempre fuori', async () => {
  const { server, mods } = await setup()
  await startInstall(server, ['tmm-TmmLiveMap'])
  await writeFile(join(mods, 'Altra.tmod'), tmod('Altra', '2.0'))
  await mkdir(join(server.saveDir, 'ModConfigs'), { recursive: true })
  await writeFile(join(server.saveDir, 'ModConfigs', 'TmmLiveMap_Config.json'), '{}')

  const pack = await createModpack(server, { name: 'Pack', description: '', mods: ['Altra', 'TmmLiveMap'], versions: {} })
  assert.deepEqual((await listModpacks(server)).find((p) => p.id === pack.id)?.addons, ['TmmLiveMap'])
  const zip = await exportModpackZip(server, pack.id)
  const listing = execFileSync('unzip', ['-Z1', zip.path], { encoding: 'utf8' }).trim().split('\n')
  assert.deepEqual(listing, ['Pack/Mods/Altra.tmod', 'Pack/Mods/enabled.json'])
  const out = join(zip.path, '..', 'out')
  execFileSync('unzip', ['-q', zip.path, '-d', out])
  assert.deepEqual(JSON.parse(await readFile(join(out, 'Pack', 'Mods', 'enabled.json'), 'utf8')), ['Altra'])
  await zip.cleanup()

  const only = await createModpack(server, { name: 'Solo mappa', description: '', mods: ['TmmLiveMap'], versions: {} })
  await assert.rejects(exportModpackZip(server, only.id), /solo add-on/)
})

test('Mondo su tModLoader: con LiveMap installata e abilitata la mappa è quella in tempo reale', async () => {
  const { server, mods } = await setup()
  const off = await worldMap(server, { watching: true })
  assert.deepEqual(off.liveMap, { available: true, installed: false, enabled: false })

  await startInstall(server, ['tmm-TmmLiveMap'])
  assert.deepEqual((await worldMap(server)).liveMap, { available: true, installed: true, enabled: false })
  await writeFile(join(mods, 'enabled.json'), '["TmmLiveMap"]')
  const dir = join(server.saveDir, 'LiveMap')
  assert.equal((await worldMap(server, { watching: true })).liveMap?.enabled, true)
  assert.ok((await stat(join(dir, 'viewer'))).mtimeMs > Date.now() - 5000)

  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      format: 1,
      world: { name: 'Prova', id: 7, width: 400, height: 300, spawnX: 200, spawnY: 90, surface: 110, rock: 160 },
      chunkWidth: 200, chunkHeight: 150, cols: 2, rows: 2, chunks: [1, 1, 1, 1], hashes: [],
      overview: { scale: 4, width: 100, height: 75, version: 1 },
      progress: { drawn: 4, total: 4 },
    }),
  )
  const live = await worldMap(server)
  assert.equal(live.source, 'livemap')
  assert.equal(live.manifest?.world.name, 'Prova')
})

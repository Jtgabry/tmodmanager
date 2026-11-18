import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { config } from '../src/config.ts'
import { ModError, withServerLock } from '../src/mods.ts'
import {
  deleteOldPluginVersions,
  deletePlugin,
  deletePluginVersion,
  listPlugins,
  pluginsFingerprint,
  readAssemblyInfo,
  setPluginEnabled,
  uploadPlugin,
  usePluginVersion,
} from '../src/plugins.ts'
import { ServerDefinition } from '../src/registry.ts'
import { getTrashItem, listTrash } from '../src/trash.ts'
import { restorePlugin } from '../src/plugins.ts'

/** Voce di VS_VERSIONINFO: { wLength, wValueLength, wType }, chiave, allineamento a 4, valore. */
function versionEntry(key: string, value: string) {
  const keyBytes = Buffer.from(`${key}\0`, 'utf16le')
  const pad = (4 - ((6 + keyBytes.length) % 4)) % 4
  const valueBytes = Buffer.from(`${value}\0`, 'utf16le')
  const header = Buffer.alloc(6)
  header.writeUInt16LE(6 + keyBytes.length + pad + valueBytes.length, 0)
  header.writeUInt16LE(value.length + 1, 2)
  header.writeUInt16LE(1, 4)
  return Buffer.concat([header, keyBytes, Buffer.alloc(pad), valueBytes, Buffer.alloc((4 - (valueBytes.length % 4)) % 4)])
}

/** Assembly .NET minimo: intestazione PE con directory CLR, risorsa di versione, TerrariaPlugin se plugin. */
function fakeAssembly({ name, version, plugin = true, build = '' }: { name: string; version: string; plugin?: boolean; build?: string }) {
  const pe = Buffer.alloc(0x200)
  pe.write('MZ', 0, 'latin1')
  pe.writeUInt32LE(0x80, 0x3c)
  pe.write('PE\0\0', 0x80, 'latin1')
  const optional = 0x80 + 24
  pe.writeUInt16LE(0x10b, optional)
  pe.writeUInt32LE(16, optional + 92)
  pe.writeUInt32LE(0x2008, optional + 96 + 14 * 8)
  pe.writeUInt32LE(72, optional + 96 + 14 * 8 + 4)
  // Allineato a 4 byte, come in una vera sezione delle risorse
  const strings = Buffer.from(`\0${plugin ? 'TerrariaPlugin' : 'Object'}\0${build}\0\0\0\0`, 'latin1')
  const padded = Buffer.concat([strings, Buffer.alloc((4 - (strings.length % 4)) % 4)])
  return Buffer.concat([
    pe,
    padded,
    Buffer.from('StringFileInfo\0', 'utf16le'),
    Buffer.alloc(2),
    versionEntry('CompanyName', 'Autore'),
    versionEntry('FileDescription', `${name} plugin`),
    versionEntry('InternalName', `${name}.dll`),
    versionEntry('ProductVersion', `${version}+abcdef`),
  ])
}

async function setup() {
  config.dataDir = await mkdtemp(join(tmpdir(), 'tmm-plugins-'))
  // Niente add-on, salvo nel test che li riguarda (in sviluppo addons/dist può contenere quelli veri)
  config.addonsDir = join(config.dataDir, 'addons')
  const install = join(config.dataDir, 'tshock', 'TShock')
  await mkdir(join(install, 'ServerPlugins'), { recursive: true })
  await writeFile(join(install, 'ServerPlugins', 'TShockAPI.dll'), fakeAssembly({ name: 'TShockAPI', version: '6.2.1' }))
  const server = ServerDefinition.parse({
    id: 'p',
    name: 'P',
    game: 'tshock',
    installDir: install,
    saveDir: join(config.dataDir, 'servers', 'p', 'save'),
    configFile: join(config.dataDir, 'servers', 'p', 'serverconfig.txt'),
  })
  const upload = (file: string, data: Buffer, enable = true) =>
    uploadPlugin(server, file, Readable.from([data]), enable, (task) => withServerLock(server, task))
  const active = () => readdir(join(server.saveDir, 'ServerPlugins')).catch(() => [])
  return { server, upload, active }
}

test('lettura delle .dll: plugin, libreria, file non .NET', () => {
  assert.deepEqual(readAssemblyInfo(fakeAssembly({ name: 'Mappa', version: '1.2.0' })), {
    name: 'Mappa',
    kind: 'plugin',
    title: 'Mappa plugin',
    version: '1.2.0',
    author: 'Autore',
    description: null,
  })
  assert.equal(readAssemblyInfo(fakeAssembly({ name: 'Lib', version: '1.0.0', plugin: false })).kind, 'library')
  assert.throws(() => readAssemblyInfo(Buffer.from('\x7fELF qualcosa')), ModError)
})

test('versioni dei plugin: ogni caricamento resta, si sceglie quale usare, si eliminano le vecchie', async () => {
  const { server, upload, active } = await setup()

  const v1 = await upload('Mappa.dll', fakeAssembly({ name: 'Mappa', version: '1.0.0' }))
  assert.equal(v1.duplicate, false)
  assert.equal(v1.previousVersion, null)
  assert.deepEqual(await active(), ['Mappa.dll'])

  // Nuova versione con un nome di file diverso: stesso plugin (nome dell'assembly), la vecchia resta salvata
  const v2 = await upload('Mappa-1.1.dll', fakeAssembly({ name: 'Mappa', version: '1.1.0' }))
  assert.equal(v2.previousVersion?.version, '1.0.0')
  assert.equal(v2.plugin.versions.length, 2)
  assert.equal(v2.plugin.selected, v2.versionId)
  assert.deepEqual(await active(), ['Mappa.dll'])
  assert.equal(readAssemblyInfo(await readFile(join(server.saveDir, 'ServerPlugins', 'Mappa.dll'))).version, '1.1.0')

  // Stessa versione ricompilata: è un'altra versione; lo stesso file ricaricato invece no
  const rebuilt = await upload('Mappa.dll', fakeAssembly({ name: 'Mappa', version: '1.1.0', build: 'b2' }))
  assert.equal(rebuilt.plugin.versions.length, 3)
  assert.equal((await upload('Mappa.dll', fakeAssembly({ name: 'Mappa', version: '1.1.0', build: 'b2' }))).duplicate, true)

  // Torna alla 1.0.0: il file attivo cambia, le altre versioni restano
  const back = await usePluginVersion(server, 'Mappa', v1.versionId)
  assert.equal(back.selected, v1.versionId)
  assert.equal(readAssemblyInfo(await readFile(join(server.saveDir, 'ServerPlugins', 'Mappa.dll'))).version, '1.0.0')

  // La versione attiva non si elimina; un'altra sì (nel cestino)
  await assert.rejects(deletePluginVersion(server, 'Mappa', v1.versionId), (e: ModError) => e.status === 409)
  const afterDelete = await deletePluginVersion(server, 'Mappa', v2.versionId)
  assert.deepEqual(afterDelete?.versions.map((v) => v.id).sort(), [v1.versionId, rebuilt.versionId].sort())

  const { removed, plugin } = await deleteOldPluginVersions(server, 'Mappa')
  assert.equal(removed, 1)
  assert.deepEqual(plugin.versions.map((v) => v.id), [v1.versionId])
  assert.equal((await listTrash(server, ['plugin'])).length, 2)

  // Una versione ripristinata dal cestino torna tra quelle salvate
  const trashed = (await listTrash(server, ['plugin'])).find((t) => t.path === `version:${v2.versionId}`)!
  const { meta, itemPath } = await getTrashItem(server, trashed.id, ['plugin'])
  await restorePlugin(server, meta, itemPath, false)
  assert.equal((await listPlugins(server)).plugins[0].versions.length, 2)
})

test('attivazione, file messi a mano, plugin di TShock ed eliminazione completa', async () => {
  const { server, upload, active } = await setup()

  // Caricato senza attivarlo: salvato ma fuori da ServerPlugins
  const lib = await upload('Lib.dll', fakeAssembly({ name: 'Lib', version: '2.0.0', plugin: false }), false)
  assert.equal(lib.plugin.enabled, false)
  assert.equal(lib.plugin.kind, 'library')
  assert.deepEqual(await active(), [])

  const before = await pluginsFingerprint(server)
  assert.equal((await setPluginEnabled(server, 'Lib', true)).enabled, true)
  assert.deepEqual(await active(), ['Lib.dll'])
  assert.notEqual(await pluginsFingerprint(server), before) // → "riavvio necessario"

  // Una .dll copiata a mano in ServerPlugins/ entra nell'elenco con la sua versione salvata
  await writeFile(join(server.saveDir, 'ServerPlugins', 'Extra.dll'), fakeAssembly({ name: 'Extra', version: '0.1.0' }))
  await writeFile(join(server.saveDir, 'ServerPlugins', 'Rotto.dll'), 'non un assembly')
  const { plugins, bundled } = await listPlugins(server)
  assert.deepEqual(
    plugins.map((p) => [p.name, p.enabled, p.versions.length, p.error !== null]),
    [
      ['Extra', true, 1, false],
      ['Lib', true, 1, false],
      ['Rotto', true, 0, true],
    ],
  )
  assert.deepEqual(bundled.map((b) => [b.file, b.version]), [['TShockAPI.dll', '6.2.1']])

  // Un plugin incluso in TShock non si carica da qui
  await assert.rejects(upload('TShockAPI.dll', fakeAssembly({ name: 'TShockAPI', version: '9.9.9' })), (e: ModError) => e.status === 409)

  // Disattivato: il file sparisce da ServerPlugins, la versione resta e si riattiva
  await setPluginEnabled(server, 'Extra', false)
  assert.deepEqual((await active()).sort(), ['Lib.dll', 'Rotto.dll'])
  await setPluginEnabled(server, 'Extra', true)
  assert.ok((await active()).includes('Extra.dll'))

  // Eliminazione: un solo elemento nel cestino con tutte le versioni; ripristinato torna disattivato
  await deletePlugin(server, 'Extra')
  await deletePlugin(server, 'Rotto')
  assert.deepEqual(await active(), ['Lib.dll'])
  const item = (await listTrash(server, ['plugin'])).find((t) => t.modName === 'Extra')!
  const { meta, itemPath } = await getTrashItem(server, item.id, ['plugin'])
  await restorePlugin(server, meta, itemPath, false)
  const extra = (await listPlugins(server)).plugins.find((p) => p.name === 'Extra')
  assert.deepEqual([extra?.enabled, extra?.versions.length], [false, 1])
})

test('add-on di tModManager: in elenco disattivato, si attiva, si aggiorna con il pannello, non si carica né si elimina', async () => {
  const { server, upload, active } = await setup()
  await mkdir(config.addonsDir, { recursive: true })
  await writeFile(join(config.addonsDir, 'LiveMap.dll'), fakeAssembly({ name: 'LiveMap', version: '1.0.0' }))

  const listed = (await listPlugins(server)).plugins
  assert.deepEqual(
    listed.map((p) => [p.name, p.addon, p.enabled, p.versions.length]),
    [['LiveMap', true, false, 1]],
  )
  assert.deepEqual(await active(), [])

  assert.equal((await setPluginEnabled(server, 'LiveMap', true)).enabled, true)
  assert.deepEqual(await active(), ['LiveMap.dll'])

  // Nuova build distribuita con il pannello: il file attivo si aggiorna da solo
  await writeFile(join(config.addonsDir, 'LiveMap.dll'), fakeAssembly({ name: 'LiveMap', version: '1.1.0' }))
  const updated = (await listPlugins(server)).plugins.find((p) => p.name === 'LiveMap')
  assert.equal(updated?.versions[0].version, '1.1.0')
  assert.equal(readAssemblyInfo(await readFile(join(server.saveDir, 'ServerPlugins', 'LiveMap.dll'))).version, '1.1.0')
  // ...e non finisce tra le versioni dei plugin caricati
  assert.equal((await readdir(join(config.dataDir, 'servers', 'p')).catch(() => [])).includes('plugins'), false)

  await assert.rejects(upload('LiveMap.dll', fakeAssembly({ name: 'LiveMap', version: '9.0.0' })), (e: ModError) => e.status === 409)
  await assert.rejects(deletePlugin(server, 'LiveMap'), (e: ModError) => e.status === 409)

  await setPluginEnabled(server, 'LiveMap', false)
  assert.deepEqual(await active(), [])
})

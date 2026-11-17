import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ModEntry } from '../src/mods.ts'
import { bbcodeToText, compatibility, modStatus, normalize, parseSteamOutput, parseVersionSummary, parseWorkshopId, pickVersion, type WorkshopItem } from '../src/workshop.ts'

test('ID del Workshop da link o numero', () => {
  assert.equal(parseWorkshopId('2824688072'), '2824688072')
  assert.equal(parseWorkshopId(' https://steamcommunity.com/sharedfiles/filedetails/?id=2824688072&searchtext= '), '2824688072')
  assert.equal(parseWorkshopId('https://steamcommunity.com/workshop/filedetails/?id=123'), '123')
  assert.equal(parseWorkshopId('https://evil.example/?id=123'), null)
  assert.equal(parseWorkshopId('abc'), null)
})

const summary = '2026.6.3.4:2.2.4;2022.9.47.46:2.0.2.3;2025.12.3.1:2.1.2;2026.4.3.0:2.2.1'

test('versionsummary e scelta della versione per la tModLoader del server', () => {
  assert.equal(parseVersionSummary(summary).length, 4)
  assert.deepEqual(parseVersionSummary('x:y;1.0:'), [])
  const entries = parseVersionSummary(summary)
  assert.deepEqual(pickVersion(entries, '2026.09.3.1'), { latest: { tml: '2026.6.3.4', mod: '2.2.4' }, newer: null })
  assert.deepEqual(pickVersion(entries, '2026.5.1.0'), {
    latest: { tml: '2026.4.3.0', mod: '2.2.1' },
    newer: { tml: '2026.6.3.4', mod: '2.2.4' },
  })
  assert.equal(pickVersion(entries, '2022.1.0.0').latest, null)
})

const mod = (version: string, modifiedAt = '2026-10-01T00:00:00.000Z') => ({ name: 'CalamityMod', displayName: 'Calamity', version, modifiedAt }) as ModEntry
const item = (over: Partial<WorkshopItem> = {}): WorkshopItem => ({
  id: '1',
  found: true,
  title: 'Calamity Mod',
  modName: 'CalamityMod',
  versions: parseVersionSummary(summary),
  timeUpdated: '2026-10-15T00:00:00.000Z',
  fileSize: 1,
  url: 'u',
  tags: [],
  previewUrl: null,
  subscriptions: null,
  ...over,
})
const link = { id: '1', source: 'auto' as const, checkedAt: '' }

test('stato degli aggiornamenti', () => {
  const tml = '2026.9.3.1'
  assert.equal(modStatus(mod('2.2.1'), link, item(), tml).status, 'update')
  assert.equal(modStatus(mod('2.2.4'), link, item(), tml).status, 'current')
  assert.equal(modStatus(mod('2.2.4'), undefined, undefined, tml).status, 'unlinked')
  assert.equal(modStatus(mod('2.2.4'), { ...link, id: null, source: 'manual' }, undefined, tml).link, 'manual')
  assert.equal(modStatus(mod('2.2.4'), link, item({ found: false }), tml).status, 'unavailable')
  assert.equal(modStatus(mod('2.0.0'), link, item(), '2022.1.0.0').status, 'incompatible')
  // Senza versioni (niente chiave): conta la data
  assert.equal(modStatus(mod('1'), link, item({ versions: [] }), tml).status, 'maybe')
  assert.equal(modStatus(mod('1', '2026-11-01T00:00:00.000Z'), link, item({ versions: [] }), tml).status, 'current')
  const s = modStatus(mod('2.2.0'), link, item(), '2026.5.0.0')
  assert.deepEqual([s.status, s.latestVersion, s.newerVersion, s.newerRequiresTml], ['update', '2.2.1', '2.2.4', '2026.6.3.4'])
})

// --- Scelta della build scaricata e installazione ------------------------------------------------

import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteArchived, listArchive, useArchivedVersion } from '../src/archive.ts'
import { config } from '../src/config.ts'
import { installModFile, listMods } from '../src/mods.ts'
import type { ServerDefinition } from '../src/registry.ts'
import { readModInfo } from '../src/tmod.ts'
import { listTrash } from '../src/trash.ts'
import { pickBuild } from '../src/workshop.ts'

/** .tmod minimo valido: intestazione senza file interni. */
function tmod(name: string, version: string, tml: string) {
  const str = (s: string) => Buffer.concat([Buffer.from([Buffer.byteLength(s)]), Buffer.from(s)])
  const count = Buffer.alloc(4)
  return Buffer.concat([Buffer.from('TMOD'), str(tml), Buffer.alloc(20), Buffer.alloc(256), Buffer.alloc(4), str(name), str(version), count])
}

test('build del Workshop: si sceglie la più recente compatibile con la tModLoader del server', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmm-ws-'))
  await writeFile(join(dir, 'Wikithis.tmod'), tmod('Wikithis', '2.6', '2026.10.1.0'))
  await mkdir(join(dir, '2026.6'))
  await writeFile(join(dir, '2026.6', 'Wikithis.tmod'), tmod('Wikithis', '2.5.1.5', '2026.6.3.4'))
  await mkdir(join(dir, '2022.9'))
  await writeFile(join(dir, '2022.9', 'Wikithis.tmod'), tmod('Wikithis', '2.0', '2022.9.47.46'))

  assert.equal((await pickBuild(dir, 'Wikithis', '2026.09.3.1')).info.version, '2.5.1.5')
  assert.equal((await pickBuild(dir, 'Wikithis', '2026.11.0.0')).info.version, '2.6')
  assert.equal((await pickBuild(dir, 'Wikithis', '2023.1.0.0')).info.version, '2.0')
  await assert.rejects(pickBuild(dir, 'Wikithis', '2021.1.0.0'), /aggiorna prima tModLoader/)
  await assert.rejects(pickBuild(dir, 'CalamityMod', '2026.09.3.1'), /contiene la mod "Wikithis"/)
})

test('installazione di una versione nuova: la vecchia va nell\'archivio, lo stato di abilitazione resta', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tmm-inst-'))
  const previous = config.dataDir
  config.dataDir = join(root, 'data')
  try {
    const server = { id: 'prova', saveDir: join(root, 'save') } as ServerDefinition
    await mkdir(join(server.saveDir, 'Mods'), { recursive: true })
    await writeFile(join(server.saveDir, 'Mods', 'Wikithis.tmod'), tmod('Wikithis', '2.5.1.4', '2026.6.3.4'))
    await writeFile(join(server.saveDir, 'Mods', 'enabled.json'), '["Wikithis"]')

    const download = join(root, 'dl.tmod')
    await writeFile(download, tmod('Wikithis', '2.5.1.5', '2026.6.3.4'))
    const result = await installModFile(server, download, await readModInfo(download), false)

    assert.equal(result.replacedVersion, '2.5.1.4')
    const mod = (await listMods(server)).mods.find((m) => m.name === 'Wikithis')
    assert.equal(mod?.version, '2.5.1.5')
    assert.equal(mod?.enabled, true)
    assert.deepEqual((await readdir(join(server.saveDir, 'Mods'))).sort(), ['Wikithis.tmod', 'enabled.json'])
    assert.deepEqual(await listTrash(server, ['mod']), [])
    const archive = await listArchive(server)
    assert.deepEqual(
      archive.map((e) => [e.name, e.installedVersion, e.versions.map((v) => v.version)]),
      [['Wikithis', '2.5.1.5', ['2.5.1.4']]],
    )

    // Tornare alla versione archiviata la scambia con quella installata, che resta abilitata
    await useArchivedVersion(server, 'Wikithis', '2.5.1.4')
    const back = (await listMods(server)).mods.find((m) => m.name === 'Wikithis')
    assert.deepEqual([back?.version, back?.enabled], ['2.5.1.4', true])
    assert.deepEqual((await listArchive(server))[0].versions.map((v) => v.version), ['2.5.1.5'])
    await assert.rejects(useArchivedVersion(server, 'Wikithis', '9.9'), /non presente nell'archivio/)

    // La stessa versione ricaricata non finisce nell'archivio (sarebbe un doppione) ma nel cestino
    const same = join(root, 'same.tmod')
    await writeFile(same, tmod('Wikithis', '2.5.1.4', '2026.6.3.4'))
    await installModFile(server, same, await readModInfo(same), false)
    assert.deepEqual((await listTrash(server, ['mod'])).map((t) => t.modVersion), ['2.5.1.4'])
    assert.deepEqual((await listArchive(server))[0].versions.map((v) => v.version), ['2.5.1.5'])

    await deleteArchived(server, 'Wikithis', '2.5.1.5')
    assert.deepEqual(await listArchive(server), [])
    await assert.rejects(deleteArchived(server, 'Wikithis', '2.5.1.5'), /non presente/)
  } finally {
    config.dataDir = previous
  }
})

test('output di steamcmd: eventi sulla stessa riga e spezzati tra due blocchi', () => {
  const real =
    '\x1b[0mWaiting for user info...\x1b[0mOK\n\x1b[0mDownloading item 2832487441 ...\x1b[0m\n' +
    '\x1b[0mSuccess. Downloaded item 2832487441 to "/d/content/1281930/2832487441" (213976 bytes) \x1b[0mDownloading item 1 ...\x1b[0m\n' +
    '\x1b[0mERROR! Download item 1 failed (File Not Found).\x1b[0mUnloading Steam API...'
  assert.deepEqual(
    parseSteamOutput(real).events.map((e) => [e.kind, e.id, e.detail]),
    [
      ['start', '2832487441', ''],
      ['done', '2832487441', '/d/content/1281930/2832487441'],
      ['start', '1', ''],
      ['error', '1', 'File Not Found'],
    ],
  )
  // Lo stesso testo a pezzi: nessun evento perso né duplicato
  for (let size = 1; size <= 40; size++) {
    const kinds: string[] = []
    let buffer = ''
    for (let i = 0; i < real.length; i += size) {
      const parsed = parseSteamOutput(buffer + real.slice(i, i + size))
      buffer = parsed.rest
      kinds.push(...parsed.events.map((e) => `${e.kind}:${e.id}`))
    }
    assert.deepEqual(kinds, ['start:2832487441', 'done:2832487441', 'start:1', 'error:1'], `blocchi da ${size}`)
  }
})

test('dettagli del Workshop: tag, anteprima e iscritti', () => {
  const item = normalize({
    publishedfileid: '2824688072',
    result: 1,
    consumer_appid: 1281930,
    title: 'Calamity Mod',
    preview_url: 'https://images.steamusercontent.com/ugc/1/',
    subscriptions: 1234,
    tags: [{ tag: 'Content', display_name: 'Content' }, { tag: 'Library' }, { tag: 'Content' }, { tag: ' ' }],
    kvtags: [{ key: 'name', value: 'CalamityMod' }],
  })
  assert.equal(item.found, true)
  assert.equal(item.modName, 'CalamityMod')
  assert.deepEqual(item.tags, ['Content', 'Library'])
  assert.equal(item.previewUrl, 'https://images.steamusercontent.com/ugc/1/')
  assert.equal(item.subscriptions, 1234)

  const empty = normalize({}, '1')
  assert.deepEqual(empty.tags, [])
  assert.equal(empty.previewUrl, null)
  assert.equal(empty.subscriptions, null)
})

test('descrizione del Workshop in testo semplice', () => {
  const raw = '[img]https://i.imgur.com/a.gif[/img]\r\n\r\n[h1]Recipe Browser![/h1]\r\nUn [b]ottimo[/b] [url=https://x.example]sito[/url].\r\n[list][*]Uno[*]Due[/list][previewyoutube=abc;full][/previewyoutube]\r\n\r\n\r\n\r\nFine [1.4.4]'
  assert.equal(bbcodeToText(raw), 'Recipe Browser!\n\nUn ottimo sito.\n• Uno• Due\n\nFine [1.4.4]')
  assert.equal(bbcodeToText('[img]x[/img]'), null)
  assert.equal(bbcodeToText(null), null)
})

test('compatibilità con la tModLoader del server', () => {
  const entries = parseVersionSummary(summary)
  assert.deepEqual(compatibility(entries, '2026.9.3.1'), { compatibleVersion: '2.2.4', requiresTml: null })
  assert.deepEqual(compatibility(entries, '2022.1.0.0'), { compatibleVersion: null, requiresTml: '2022.9.47.46' })
  assert.deepEqual(compatibility([], '2026.9.3.1'), { compatibleVersion: null, requiresTml: null })
})

test('modpack con versione bloccata: l\'attivazione passa alla versione dell\'archivio', async () => {
  const { createModpack, enableModpack, listModpacks, packsPinning } = await import('../src/modpacks.ts')
  const root = await mkdtemp(join(tmpdir(), 'tmm-pack-'))
  const previous = config.dataDir
  config.dataDir = join(root, 'data')
  try {
    const server = { id: 'prova', saveDir: join(root, 'save') } as ServerDefinition
    await mkdir(join(server.saveDir, 'Mods'), { recursive: true })
    await writeFile(join(server.saveDir, 'Mods', 'Wikithis.tmod'), tmod('Wikithis', '2.0', '2026.6.3.4'))
    // Aggiornamento: la 2.0 va nell'archivio
    const update = join(root, 'up.tmod')
    await writeFile(update, tmod('Wikithis', '2.1', '2026.6.3.4'))
    await installModFile(server, update, await readModInfo(update), false)

    const pack = await createModpack(server, { name: 'Vecchio', description: '', mods: ['Wikithis', 'Assente'], versions: { Wikithis: '2.0', Fuori: '1.0' } })
    assert.deepEqual(pack.versions, { Wikithis: '2.0' })
    let [view] = await listModpacks(server)
    assert.deepEqual(view.toSwitch, [{ name: 'Wikithis', from: '2.1', to: '2.0' }])
    assert.deepEqual(view.missing, ['Assente'])
    await assert.rejects(enableModpack(server, pack.id), /non installate: Assente/)
    // Il tentativo fallito non ha cambiato versione
    assert.equal((await listMods(server)).mods[0].version, '2.1')

    const ok = await createModpack(server, { name: 'Solo wiki', description: '', mods: ['Wikithis'], versions: { Wikithis: '2.0' } })
    assert.deepEqual(await packsPinning(server, 'Wikithis', '2.0'), ['Vecchio', 'Solo wiki'])
    const result = await enableModpack(server, ok.id)
    assert.deepEqual(result.switched, [{ name: 'Wikithis', from: '2.1', to: '2.0' }])
    assert.deepEqual(result.enabled, ['Wikithis'])
    assert.equal((await listMods(server)).mods[0].version, '2.0')
    view = (await listModpacks(server)).find((p) => p.id === ok.id)!
    assert.equal(view.state, 'enabled')
    assert.deepEqual((await listArchive(server))[0].versions.map((v) => v.version), ['2.1'])
  } finally {
    config.dataDir = previous
  }
})

test('«attiva solo questo»: restano abilitate solo le mod del pack e le loro dipendenze', async () => {
  const { createModpack, enableModpack, listModpacks } = await import('../src/modpacks.ts')
  const { readEnabled } = await import('../src/mods.ts')
  const root = await mkdtemp(join(tmpdir(), 'tmm-excl-'))
  const previous = config.dataDir
  config.dataDir = join(root, 'data')
  try {
    const server = { id: 'prova', saveDir: join(root, 'save') } as ServerDefinition
    await mkdir(join(server.saveDir, 'Mods'), { recursive: true })
    for (const name of ['Alfa', 'Beta', 'Gamma']) await writeFile(join(server.saveDir, 'Mods', `${name}.tmod`), tmod(name, '1.0', '2026.6.3.4'))
    await writeFile(join(server.saveDir, 'Mods', 'enabled.json'), '["Beta","Gamma"]')

    const other = await createModpack(server, { name: 'Altro', description: '', mods: ['Beta', 'Gamma'], versions: {} })
    assert.equal(other.active, true)
    const pack = await createModpack(server, { name: 'Solo alfa', description: '', mods: ['Alfa'], versions: {} })

    // Normale: si aggiunge alle mod già abilitate
    await enableModpack(server, pack.id)
    assert.deepEqual((await readEnabled(server)).sort(), ['Alfa', 'Beta', 'Gamma'])

    // Esclusivo: le altre si spengono e l'altro pack risulta disattivo
    const result = await enableModpack(server, pack.id, { exclusive: true })
    assert.deepEqual(result.disabled.sort(), ['Beta', 'Gamma'])
    assert.deepEqual(result.deactivated, ['Altro'])
    assert.deepEqual(await readEnabled(server), ['Alfa'])
    const views = await listModpacks(server)
    assert.deepEqual(views.map((p) => [p.name, p.state]), [['Altro', 'disabled'], ['Solo alfa', 'enabled']])
  } finally {
    config.dataDir = previous
  }
})

test('esportazione del modpack: cartella di tModLoader in .zip, con versioni bloccate e configurazioni', async () => {
  const { execFileSync } = await import('node:child_process')
  const { readFile } = await import('node:fs/promises')
  const { createModpack } = await import('../src/modpacks.ts')
  const { exportModpackZip, packFolderName } = await import('../src/modpackExport.ts')
  const root = await mkdtemp(join(tmpdir(), 'tmm-export-'))
  const previous = config.dataDir
  config.dataDir = join(root, 'data')
  try {
    const server = { id: 'prova', saveDir: join(root, 'save') } as ServerDefinition
    await mkdir(join(server.saveDir, 'Mods'), { recursive: true })
    await mkdir(join(server.saveDir, 'ModConfigs'), { recursive: true })
    await writeFile(join(server.saveDir, 'Mods', 'Wikithis.tmod'), tmod('Wikithis', '2.0', '2026.6.3.4'))
    await writeFile(join(server.saveDir, 'Mods', 'Altra.tmod'), tmod('Altra', '1.0', '2026.6.3.4'))
    // Aggiornamento: la 2.0 va nell'archivio, il pack la tiene bloccata
    const update = join(root, 'up.tmod')
    await writeFile(update, tmod('Wikithis', '2.1', '2026.6.3.4'))
    await installModFile(server, update, await readModInfo(update), false)
    await writeFile(join(server.saveDir, 'ModConfigs', 'Wikithis_ClientConfig.json'), '{"a":1}')
    await writeFile(join(server.saveDir, 'ModConfigs', 'Altra_ServerConfig.json'), '{"b":2}')

    const pack = await createModpack(server, { name: 'Il mio: pack?', description: '', mods: ['Wikithis'], versions: { Wikithis: '2.0' } })
    assert.equal(packFolderName(pack.name), 'Il mio_ pack_')
    const zip = await exportModpackZip(server, pack.id)
    assert.equal(zip.filename, 'Il mio_ pack_.zip')
    const listing = execFileSync('unzip', ['-Z1', zip.path], { encoding: 'utf8' }).trim().split('\n')
    assert.deepEqual(listing, ['Il mio_ pack_/Mods/Wikithis.tmod', 'Il mio_ pack_/Mods/enabled.json', 'Il mio_ pack_/ModConfigs/Wikithis_ClientConfig.json'])
    execFileSync('unzip', ['-tq', zip.path])
    const out = join(root, 'out')
    execFileSync('unzip', ['-q', zip.path, '-d', out])
    assert.deepEqual(JSON.parse(await readFile(join(out, 'Il mio_ pack_', 'Mods', 'enabled.json'), 'utf8')), ['Wikithis'])
    assert.equal((await readModInfo(join(out, 'Il mio_ pack_', 'Mods', 'Wikithis.tmod'))).version, '2.0')
    await zip.cleanup()

    const empty = await createModpack(server, { name: 'Vuoto', description: '', mods: [], versions: {} })
    await assert.rejects(exportModpackZip(server, empty.id), /vuoto/)
  } finally {
    config.dataDir = previous
  }
})

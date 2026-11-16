import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { config } from '../src/config.ts'
import { signTicket, verifyTicket } from '../src/consoleHub.ts'
import { limitedAllows } from '../src/files.ts'
import { parseModList } from '../src/modpackImport.ts'
import type { ServerDefinition } from '../src/registry.ts'
import { applyServerConfig, parseServerConfig } from '../src/serverConfig.ts'
import { compareVersions } from '../src/tml.ts'
import { emptyTrash, listTrash, moveToTrash, purgeExpiredTrash } from '../src/trash.ts'

test('cartella di tModLoader: solo .txt di primo livello e log', () => {
  assert.equal(limitedAllows('', 'list'), true)
  assert.equal(limitedAllows('', 'write'), false)
  assert.equal(limitedAllows('serverconfig.txt', 'read'), true)
  assert.equal(limitedAllows('serverconfig.txt', 'write'), true)
  assert.equal(limitedAllows('serverconfig.txt', 'modify'), true)
  assert.equal(limitedAllows('tModLoader.dll', 'read'), false)
  assert.equal(limitedAllows('start-tModLoaderServer.sh', 'write'), false)
  assert.equal(limitedAllows('dotnet', 'list'), false)
  assert.equal(limitedAllows('Content/x.txt', 'read'), false)
  assert.equal(limitedAllows('tModLoader-Logs', 'list'), true)
  assert.equal(limitedAllows('tModLoader-Logs/server.log', 'read'), true)
  assert.equal(limitedAllows('tModLoader-Logs/server.log', 'write'), false)
})

test('serverconfig: modifica chiavi mantenendo commenti, rimozione e aggiunta', () => {
  const before = '#port=1\nport=7777\nPassword=old\nmaxplayers=8\n\n'
  const after = applyServerConfig(before, { port: '7778', password: null, motd: 'Ciao' })
  assert.equal(after, '#port=1\nport=7778\nmaxplayers=8\nmotd=Ciao\n')
  const parsed = parseServerConfig(after)
  assert.equal(parsed.port, 7778)
  assert.equal(parsed.hasPassword, false)
})

test('ticket WebSocket: firma, scadenza e server', () => {
  const token = 'x'.repeat(40)
  const now = Date.now()
  const ticket = signTicket({ s: 'alpha', u: 3, e: Math.floor(now / 1000) + 30 }, token)
  assert.deepEqual(verifyTicket(ticket, 'alpha', now, token), { userId: 3 })
  assert.equal(verifyTicket(ticket, 'beta', now, token), null)
  assert.equal(verifyTicket(ticket, 'alpha', now + 60_000, token), null)
  assert.equal(verifyTicket(ticket, 'alpha', now, 'y'.repeat(40)), null)
  const [body] = ticket.split('.')
  assert.equal(verifyTicket(`${body}.AAAA`, 'alpha', now, token), null)
  assert.equal(verifyTicket(undefined, 'alpha', now, token), null)
})

test('versioni di tModLoader', () => {
  assert.ok(compareVersions('2026.10.2.3', '2026.09.3.1') > 0)
  assert.ok(compareVersions('2026.9.3.1', '2026.09.3.1') === 0)
  assert.ok(compareVersions('2026.08.3.0', '2026.8.3.1') < 0)
})

test('elenco mod di un modpack', () => {
  assert.deepEqual(parseModList('﻿["CalamityMod","Bad Name","CalamityMod",3,"Luminance"]'), ['CalamityMod', 'Luminance'])
  assert.throws(() => parseModList('{"a":1}'))
  assert.throws(() => parseModList('non json'))
})

test('cestino: elenco per tipo, giorni rimasti, scadenza a 30 giorni', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tmm-trash-'))
  const previous = config.dataDir
  config.dataDir = join(root, 'data')
  try {
    const server = { id: 'test' } as ServerDefinition
    const file = join(root, 'a.txt')
    await writeFile(file, 'ciao')
    await moveToTrash(server, file, { kind: 'file', name: 'a.txt', root: 'save', path: 'a.txt', modName: null, modVersion: null, reason: 'deleted' })
    const dir = join(root, 'cartella')
    await mkdir(dir)
    await writeFile(join(dir, 'b'), '12345')
    await moveToTrash(server, dir, { kind: 'mod', name: 'X.tmod', root: null, path: null, modName: 'X', modVersion: '1', reason: 'deleted' })

    const files = await listTrash(server, ['file'])
    assert.equal(files.length, 1)
    assert.equal(files[0].daysLeft, 30)
    assert.equal(files[0].size, 4)
    const all = await listTrash(server, ['file', 'mod'])
    assert.equal(all.length, 2)
    assert.equal(all.find((i) => i.kind === 'mod')?.size, 5)

    // Un elemento di 31 giorni fa viene cancellato, gli altri no
    const old = all.find((i) => i.kind === 'file')!
    const metaPath = join(config.dataDir, 'servers', 'test', 'trash', old.id, 'meta.json')
    const meta = JSON.parse(await readFile(metaPath, 'utf8'))
    meta.deletedAt = new Date(Date.now() - 31 * 86_400_000).toISOString()
    await writeFile(metaPath, JSON.stringify(meta))
    // Cartella senza meta (vecchio formato): conta il mtime
    const legacy = join(config.dataDir, 'servers', 'test', 'trash', 'files')
    await mkdir(legacy)
    const longAgo = new Date(Date.now() - 40 * 86_400_000)
    await utimes(legacy, longAgo, longAgo)

    assert.equal(await purgeExpiredTrash(), 2)
    assert.deepEqual((await listTrash(server, ['file', 'mod'])).map((i) => i.kind), ['mod'])
    assert.equal(await emptyTrash(server, ['file']), 0)
    assert.equal(await emptyTrash(server, ['mod']), 1)
    assert.deepEqual(await readdir(join(config.dataDir, 'servers', 'test', 'trash')), [])
  } finally {
    config.dataDir = previous
  }
})

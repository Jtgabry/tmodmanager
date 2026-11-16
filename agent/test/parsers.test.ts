import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseStat, parseTcpTable } from '../src/procfs.ts'
import { parseScreenList } from '../src/screen.ts'
import { parseServerConfig, parseTmlVersion } from '../src/serverConfig.ts'

test('parseScreenList estrae pid e nome delle sessioni', () => {
  const out = 'There are screens on:\n\t44886.server\t(01/11/2026 15:49:06)\t(Detached)\n\t123.tml-test\t(03/11/2026)\t(Attached)\n2 Sockets in /run/screen/S-utente.\n'
  assert.deepEqual(parseScreenList(out), [
    { pid: 44886, name: 'server' },
    { pid: 123, name: 'tml-test' },
  ])
  assert.deepEqual(parseScreenList('No Sockets found in /run/screen/S-utente.\n'), [])
})

test('parseStat gestisce comm con spazi e parentesi', () => {
  // campi dopo ")": state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime prio nice threads itreal starttime
  const stat = '97046 (dotnet (x) y) S 97043 1 1 0 -1 0 0 0 0 0 1500 250 0 0 20 0 30 0 123456 0'
  assert.deepEqual(parseStat(stat), { ppid: 97043, cpuTicks: 1750, startTicks: 123456 })
})

test('parseTcpTable conta LISTEN ed ESTABLISHED sulla porta', () => {
  const table = [
    '  sl  local_address rem_address   st tx_queue rx_queue',
    '   0: 00000000:1E61 00000000:0000 0A 00000000:00000000',
    '   1: 4130BB2D:1E61 0A1C4A2D:DD70 01 00000000:00000000',
    '   2: 4130BB2D:1E61 0B1C4A2D:DD71 01 00000000:00000000',
    '   3: 0100007F:0CEA 00000000:0000 0A 00000000:00000000',
  ].join('\n')
  assert.deepEqual(parseTcpTable(table, 7777), { listening: true, established: 2 })
  assert.deepEqual(parseTcpTable(table, 7778), { listening: false, established: 0 })
})

test('parseServerConfig legge le chiavi e applica i default', () => {
  const cfg = parseServerConfig('#port=9999\nworld=/home/utente/Worlds/Alfa.wld\n  maxplayers = 16\npassword=\n')
  assert.equal(cfg.worldName, 'Alfa')
  assert.equal(cfg.port, 7777)
  assert.equal(cfg.maxPlayers, 16)
  assert.equal(cfg.hasPassword, false)
})

test('parseTmlVersion legge la versione dalla prima riga del log', () => {
  const line = '[16:12:04.041] [Main Thread/INFO] [tML]: Starting tModLoader server 1.4.4.9+2026.09.3.1|2026.09|stable|Stable|4f07'
  assert.equal(parseTmlVersion(line), '2026.09.3.1')
  assert.equal(parseTmlVersion('altro'), null)
})

test('icona della mod: icon.png estratto dal .tmod (anche compresso), null se manca o non è un PNG', async () => {
  const { deflateRawSync } = await import('node:zlib')
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { readModIcon, readModInfo } = await import('../src/tmod.ts')

  const str = (s: string) => Buffer.concat([Buffer.from([Buffer.byteLength(s)]), Buffer.from(s)])
  const int = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeInt32LE(n)
    return b
  }
  /** .tmod con i file interni indicati (`compress`: salvati compressi, come fa tModLoader con i file grandi). */
  const tmod = (files: { path: string; data: Buffer; compress?: boolean }[]) => {
    const stored = files.map((f) => ({ ...f, stored: f.compress ? deflateRawSync(f.data) : f.data }))
    const table = stored.map((f) => Buffer.concat([str(f.path), int(f.data.length), int(f.stored.length)]))
    return Buffer.concat([
      Buffer.from('TMOD'), str('2026.6.3.4'), Buffer.alloc(20), Buffer.alloc(256), Buffer.alloc(4),
      str('IconMod'), str('1.0'), int(files.length), ...table, ...stored.map((f) => f.stored),
    ])
  }

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)])
  const info = Buffer.concat([str('displayName'), str('Icon Mod'), str('')])
  const dir = await mkdtemp(join(tmpdir(), 'tmm-icon-'))

  const withIcon = join(dir, 'a.tmod')
  await writeFile(withIcon, tmod([{ path: 'Info', data: info }, { path: 'icon.png', data: png, compress: true }]))
  assert.deepEqual(await readModIcon(withIcon), png)
  assert.equal((await readModInfo(withIcon)).displayName, 'Icon Mod')

  const without = join(dir, 'b.tmod')
  await writeFile(without, tmod([{ path: 'Info', data: info }]))
  assert.equal(await readModIcon(without), null)

  const notPng = join(dir, 'c.tmod')
  await writeFile(notPng, tmod([{ path: 'icon.png', data: Buffer.from('ciao') }]))
  assert.equal(await readModIcon(notPng), null)

  const broken = join(dir, 'd.tmod')
  await writeFile(broken, Buffer.from('non è una mod'))
  assert.equal(await readModIcon(broken), null)
})

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import {
  BackupError,
  backupPath,
  createBackup,
  deleteBackup,
  listBackups,
  nextRun,
  normalizeWorldName,
  restoreBackup,
  runDailyBackups,
  timestamp,
} from '../src/backups.ts'
import { config } from '../src/config.ts'
import type { ServerManager } from '../src/manager.ts'
import { paths } from '../src/paths.ts'
import { loadServers } from '../src/registry.ts'
import { createServer } from '../src/serverAdmin.ts'
import { readZipComment } from '../src/zip.ts'
import { listTrash } from '../src/trash.ts'

const run = promisify(execFile)
const stopped = { status: async () => ({ state: 'stopped', managed: false, operation: null }) } as unknown as ServerManager
const quiet = { info: () => {}, warn: () => {} }
const runningServer = { status: async () => ({ state: 'running', managed: true, operation: null }), sendCommand: async () => {} } as unknown as ServerManager

test('nome del backup: mondo normalizzato e data YmdHis', () => {
  assert.equal(normalizeWorldName('Il mio Mondo'), 'Il_mio_Mondo')
  assert.equal(normalizeWorldName("Città dell'Ombra 2"), 'Citta_dellOmbra')
  assert.equal(normalizeWorldName('a-b  c__d'), 'a-b_c_d')
  assert.equal(normalizeWorldName('1234 !!'), 'Mondo')
  assert.equal(timestamp(new Date(2026, 10, 17, 4, 5, 9)), '20261117040509')
})

test('prossimo backup giornaliero: oggi se non è ancora l\'ora, altrimenti domani', () => {
  const now = new Date(2026, 10, 17, 3, 59, 0)
  assert.deepEqual(nextRun('04:00', now), new Date(2026, 10, 17, 4, 0, 0))
  assert.deepEqual(nextRun('04:00', new Date(2026, 10, 17, 4, 0, 0)), new Date(2026, 10, 18, 4, 0, 0))
  assert.equal(nextRun('off', now), null)
  assert.equal(nextRun('25:00', now), null)
})

test('backup: zip con .wld (e .twld per tModLoader), elenco, download, eliminazione, rotazione', async () => {
  const previous = { dataDir: config.dataDir, backupKeep: config.backupKeep }
  config.dataDir = await mkdtemp(join(tmpdir(), 'tmm-backups-'))
  config.backupKeep = 2
  try {
    const tml = paths.tmlInstall()
    await mkdir(tml, { recursive: true })
    await writeFile(join(tml, 'start-tModLoaderServer.sh'), '')
    await createServer({
      id: 'mod',
      name: 'Mod',
      installDir: tml,
      port: 47_790,
      maxPlayers: 8,
      password: '',
      motd: '',
      world: { name: 'Il mio Mondo', size: 1, difficulty: 0, seed: '' },
      copyModsFrom: null,
      launchArgs: ['-nosteam'],
    })
    const [server] = await loadServers()
    assert.equal(server.game, 'tmodloader')

    // Niente mondo ancora: errore chiaro
    await assert.rejects(createBackup(server, stopped), (e: unknown) => e instanceof BackupError && e.status === 409)
    // E il giornaliero lo salta senza errori
    await runDailyBackups(stopped, quiet)

    const worlds = join(paths.serverSave('mod'), 'Worlds')
    await writeFile(join(worlds, 'Il mio Mondo.wld'), Buffer.alloc(5000, 1))
    await writeFile(join(worlds, 'Il mio Mondo.twld'), 'dati delle mod')

    const { backup, running } = await createBackup(server, stopped)
    assert.equal(running, false)
    assert.match(backup.name, /^Il_mio_Mondo_backup_\d{14}\.zip$/)
    assert.deepEqual(backup.files, ['Il mio Mondo.wld', 'Il mio Mondo.twld'])
    assert.equal(backup.auto, false)

    const { path } = await backupPath(server, backup.name)
    const { stdout } = await run('unzip', ['-Z1', path])
    assert.deepEqual(stdout.trim().split('\n'), ['Il mio Mondo.wld', 'Il mio Mondo.twld'])
    assert.equal((await run('unzip', ['-p', path, 'Il mio Mondo.twld'])).stdout, 'dati delle mod')
    await run('unzip', ['-tq', path]) // CRC e struttura valide
    assert.match(await readZipComment(path), /"auto":false/)

    // Giornalieri: si tengono solo gli ultimi config.backupKeep (2), i manuali restano
    for (let i = 0; i < 3; i++) await runDailyBackups(stopped, quiet)
    const list = await listBackups(server)
    assert.equal(list.length, 3)
    assert.deepEqual(
      list.map((b) => b.auto),
      [true, true, false],
    )
    assert.ok(list[0].createdAt >= list[1].createdAt)

    await assert.rejects(backupPath(server, '../servers.json'), BackupError)
    await assert.rejects(backupPath(server, 'Altro_backup_20200101000000.zip'), BackupError)
    await deleteBackup(server, backup.name)
    assert.equal((await readdir(paths.backups('mod'))).includes(backup.name), false)
  } finally {
    Object.assign(config, previous)
  }
})

test('ripristino: server spento, mondo attuale nel cestino, anche con un nome di mondo diverso', async () => {
  const previous = config.dataDir
  config.dataDir = await mkdtemp(join(tmpdir(), 'tmm-restore-'))
  try {
    const tml = paths.tmlInstall()
    await mkdir(tml, { recursive: true })
    await writeFile(join(tml, 'start-tModLoaderServer.sh'), '')
    await createServer({
      id: 'r',
      name: 'R',
      installDir: tml,
      port: 47_791,
      maxPlayers: 8,
      password: '',
      motd: '',
      world: { name: 'Primo', size: 1, difficulty: 0, seed: '' },
      copyModsFrom: null,
      launchArgs: ['-nosteam'],
    })
    const [server] = await loadServers()
    const worlds = join(paths.serverSave('r'), 'Worlds')
    await writeFile(join(worlds, 'Primo.wld'), 'mondo v1')
    await writeFile(join(worlds, 'Primo.twld'), 'mod v1')
    const { backup } = await createBackup(server, stopped)

    // Il mondo va avanti, poi si torna al backup
    await writeFile(join(worlds, 'Primo.wld'), 'mondo v2')
    await writeFile(join(worlds, 'Primo.twld'), 'mod v2')
    await writeFile(join(worlds, 'Primo.wld.bak'), 'bak v2')
    await assert.rejects(restoreBackup(server, backup.name, runningServer), (e: unknown) => e instanceof BackupError && e.status === 409)
    const result = await restoreBackup(server, backup.name, stopped)
    assert.deepEqual(result.restored.sort(), ['Primo.twld', 'Primo.wld'])
    assert.deepEqual(result.trashed.sort(), ['Primo.twld', 'Primo.wld', 'Primo.wld.bak'])
    assert.equal(await readFile(join(worlds, 'Primo.wld'), 'utf8'), 'mondo v1')
    assert.equal(await readFile(join(worlds, 'Primo.twld'), 'utf8'), 'mod v1')
    assert.equal((await readdir(worlds)).includes('Primo.wld.bak'), false)
    const trash = await listTrash(server, ['file'])
    assert.equal(trash.filter((t) => t.reason === 'replaced').length, 3)

    // Mondo ricreato con un altro nome: il ripristino rimette "Primo" e la configurazione punta a lui
    const config2 = server.configPath
    await writeFile(config2, (await readFile(config2, 'utf8')).replace(/^world=.*$/m, `world=${join(worlds, 'Secondo.wld')}`))
    await writeFile(join(worlds, 'Secondo.wld'), 'secondo')
    await restoreBackup(server, backup.name, stopped)
    const text = await readFile(config2, 'utf8')
    assert.match(text, new RegExp(`^world=${join(worlds, 'Primo.wld').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
    assert.match(text, /^worldname=Primo$/m)
    assert.equal((await readdir(worlds)).includes('Secondo.wld'), false)

    await assert.rejects(restoreBackup(server, 'Nessuno_backup_20200101000000.zip', stopped), BackupError)
  } finally {
    config.dataDir = previous
  }
})

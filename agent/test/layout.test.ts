import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { config, projectRoot } from '../src/config.ts'
import { paths } from '../src/paths.ts'
import { listInstallations } from '../src/tml.ts'

test('i percorsi stanno tutti sotto la cartella dati', () => {
  const previous = config.dataDir
  config.dataDir = '/srv/tmm'
  try {
    assert.equal(paths.registry(), '/srv/tmm/servers.json')
    assert.equal(paths.serverSave('alfa'), '/srv/tmm/servers/alfa/save')
    assert.equal(paths.trash('alfa'), '/srv/tmm/servers/alfa/trash')
    assert.equal(paths.tmlInstall(), '/srv/tmm/tmodloader/tModLoader')
    assert.equal(paths.terrariaInstall(), '/srv/tmm/terraria/Terraria')
    assert.equal(paths.steamcmd(), '/srv/tmm/steamcmd/steamcmd.sh')
  } finally {
    config.dataDir = previous
  }
})

test('macchina nuova: compaiono le installazioni predefinite di Terraria e tModLoader, da installare', async () => {
  const previous = config.dataDir
  config.dataDir = await mkdtemp(join(tmpdir(), 'tmm-layout-'))
  try {
    const list = await listInstallations()
    assert.deepEqual(
      list.map((i) => [i.path, i.kind, i.managed, i.installed]),
      [
        [paths.terrariaInstall(), 'terraria', true, false],
        [paths.tmlInstall(), 'tmodloader', true, false],
      ],
    )

    // Installazione esterna in uso: si aggiunge alle predefinite
    const external = join(config.dataDir, 'esterna')
    await mkdir(external)
    await writeFile(join(external, 'start-tModLoaderServer.sh'), '')
    await writeFile(
      paths.registry(),
      JSON.stringify({ servers: [{ id: 'a', name: 'A', installDir: external, saveDir: join(config.dataDir, 'a') }] }),
    )
    const withServer = await listInstallations()
    const ext = withServer.find((i) => i.path === external)
    assert.equal(ext?.installed, true)
    assert.equal(ext?.kind, 'tmodloader')
    assert.deepEqual(ext?.servers.map((s) => s.id), ['a'])
  } finally {
    config.dataDir = previous
  }
})

test('migrazione da agent/data: dati per server nelle loro cartelle, vecchia cartella rinominata', async () => {
  // migrate.ts usa <progetto>/agent/data: qui si simula con un progetto finto
  const root = await mkdtemp(join(tmpdir(), 'tmm-migrate-'))
  const legacy = join(root, 'agent', 'data')
  await mkdir(join(legacy, 'modpacks'), { recursive: true })
  await mkdir(join(legacy, 'logs'), { recursive: true })
  await mkdir(join(legacy, 'trash', 'alfa', '1700000000000-abcdef01'), { recursive: true })
  await mkdir(join(legacy, 'steamcmd'), { recursive: true })
  await writeFile(join(legacy, 'servers.json'), '{"servers":[]}')
  await writeFile(join(legacy, 'workshop.json'), '{"links":{}}')
  await writeFile(join(legacy, 'modpacks', 'alfa.json'), '{"packs":[]}')
  await writeFile(join(legacy, 'logs', 'alfa.log'), 'console')
  await writeFile(join(legacy, 'logs', 'alfa.session'), '123')
  await writeFile(join(legacy, 'trash', 'alfa', '1700000000000-abcdef01', 'meta.json'), '{}')

  const previous = config.dataDir
  config.dataDir = join(root, 'data')
  try {
    const { migrateLegacyDataFrom } = await import('../src/migrate.ts')
    const messages: string[] = []
    await migrateLegacyDataFrom(legacy, (m) => messages.push(m))

    assert.equal(await readFile(paths.registry(), 'utf8'), '{"servers":[]}')
    assert.equal(await readFile(paths.workshopLinks(), 'utf8'), '{"links":{}}')
    assert.equal(await readFile(paths.modpacks('alfa'), 'utf8'), '{"packs":[]}')
    assert.equal(await readFile(join(paths.serverLogs('alfa'), 'console.log'), 'utf8'), 'console')
    assert.equal(await readFile(join(paths.serverLogs('alfa'), 'console.session'), 'utf8'), '123')
    assert.deepEqual(await readdir(paths.trash('alfa')), ['1700000000000-abcdef01'])
    const left = await readdir(join(root, 'agent'))
    assert.equal(left.length, 1)
    assert.match(left[0], /^data\.migrated-\d{4}-\d{2}-\d{2}$/)
    assert.deepEqual(await readdir(join(root, 'agent', left[0])), ['steamcmd'].concat(['logs', 'modpacks', 'trash']).sort())

    // Seconda esecuzione: niente da fare
    await migrateLegacyDataFrom(legacy, (m) => messages.push(m))
  } finally {
    config.dataDir = previous
  }
  assert.ok(projectRoot.length > 0)
})

test('resume-servers.json: letto una volta sola, server sconosciuti ignorati', async () => {
  const { resumeServers } = await import('../src/lifecycle.ts')
  const previous = config.dataDir
  config.dataDir = await mkdtemp(join(tmpdir(), 'tmm-resume-'))
  try {
    await writeFile(paths.resumeServers(), JSON.stringify({ servers: ['sparito'] }))
    const started: string[] = []
    const manager = { start: async (s: { id: string }) => void started.push(s.id) } as unknown as Parameters<typeof resumeServers>[0]
    const warnings: string[] = []
    await resumeServers(manager, { info: () => undefined, warn: (m) => warnings.push(m) })
    assert.deepEqual(started, [])
    assert.deepEqual(warnings, [])
    await assert.rejects(readFile(paths.resumeServers(), 'utf8'))
  } finally {
    config.dataDir = previous
  }
})

test('TMM_GAME_PORTS: intervallo di porte', async () => {
  const { parsePortRange } = await import('../src/config.ts')
  assert.deepEqual(parsePortRange('7777-7787'), { min: 7777, max: 7787 })
  assert.deepEqual(parsePortRange(' 7800 '), { min: 7800, max: 7800 })
  assert.equal(parsePortRange('80-90'), null)
  assert.equal(parsePortRange('7790-7780'), null)
  assert.equal(parsePortRange(undefined), null)
})

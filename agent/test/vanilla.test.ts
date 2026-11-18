import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { config } from '../src/config.ts'
import { readWorldRelease, scanGameVersion, terrariaCode, terrariaVersionFromCode } from '../src/games.ts'
import { isServerProcess, type ServerManager } from '../src/manager.ts'
import { paths } from '../src/paths.ts'
import { loadServers, ServerDefinition } from '../src/registry.ts'
import { createServer, knownInstallations, recreateWorld, ServerAdminError, serverSettings, UpdateServerInput, updateServer } from '../src/serverAdmin.ts'
import { addVersion, findInstallation, installationWorldRelease, listInstallations, recordWorldRelease, removeInstallation, startJob, TmlError } from '../src/tml.ts'
import { listTrash } from '../src/trash.ts'

const worldHeader = (release: number) => {
  const buf = Buffer.alloc(64)
  buf.writeInt32LE(release, 0)
  buf.write('relogic', 4, 'latin1')
  return buf
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

const managerIn = (state: 'stopped' | 'running') => ({ status: async () => ({ state, operation: null }) }) as unknown as ServerManager

test('versioni di Terraria: nomi degli zip di terraria.org e stringhe negli assembly', () => {
  assert.equal(terrariaVersionFromCode('1458'), '1.4.5.8')
  assert.equal(terrariaVersionFromCode('14481'), '1.4.4.8.1')
  assert.equal(terrariaVersionFromCode('abc'), null)
  assert.equal(terrariaCode('1.4.4.9'), '1449')
  assert.equal(terrariaCode('1.4.10.1'), null)

  // Come tModLoader.dll: altre versioni nel codice, quella vera nella risorsa di versione (in fondo)
  const versionInfo = (v: string) => Buffer.concat([Buffer.from('FileVersion', 'utf16le'), Buffer.alloc(2), Buffer.from(v, 'utf16le'), Buffer.alloc(4)])
  const dll = Buffer.concat([Buffer.from('Terraria_v1.4.5.8.exe', 'utf16le'), Buffer.from('xx'), versionInfo('1.4.4.9')])
  assert.equal(scanGameVersion(dll), '1.4.4.9')
  assert.equal(scanGameVersion(Buffer.from('niente')), null)
})

test('versione del mondo: dai primi byte del .wld, null se non è un mondo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmm-world-'))
  await writeFile(join(dir, 'a.wld'), worldHeader(326))
  await writeFile(join(dir, 'b.wld'), 'non un mondo, ma abbastanza lungo')
  assert.equal(await readWorldRelease(join(dir, 'a.wld')), 326)
  assert.equal(await readWorldRelease(join(dir, 'b.wld')), null)
  assert.equal(await readWorldRelease(join(dir, 'manca.wld')), null)
})

test('installazione: versione dei mondi dalla tabella, poi da quella imparata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmm-install-'))
  assert.equal(await installationWorldRelease(dir, '1.4.4.9'), 279)
  assert.equal(await installationWorldRelease(dir, '1.4.9.9'), null)
  await writeFile(join(dir, '.tmodmanager-world-release'), '330\n')
  assert.equal(await installationWorldRelease(dir, '1.4.4.9'), 330)
})

test('processo del server vanilla: l\'eseguibile, non la sessione screen che lo lancia', () => {
  const server = ServerDefinition.parse({ id: 'v', name: 'V', game: 'terraria', installDir: '/t', saveDir: '/s', configFile: '/c/serverconfig.txt' })
  const proc = (args: string[]) => ({ pid: 1, ppid: 0, cpuTicks: 0, startTicks: 0, args })
  const binary = ['./TerrariaServer.bin.x86_64', '-config', '/c/serverconfig.txt', '-noupnp']
  assert.equal(isServerProcess(proc(binary), server), true)
  assert.equal(isServerProcess(proc(['SCREEN', '-c', '/rc', '-dmS', 'tml-v', '-L', '-Logfile', '/l', ...binary]), server), false)
  assert.equal(isServerProcess(proc(['./TerrariaServer.bin.x86_64', '-config', '/altro/serverconfig.txt']), server), false)
})

test('registry: i server senza "game" sono tModLoader', () => {
  const server = ServerDefinition.parse({ id: 'a', name: 'A', installDir: '/x', saveDir: '/y' })
  assert.equal(server.game, 'tmodloader')
})

test('server vanilla: creazione, passaggio a tModLoader, ricreazione del mondo', async () => {
  const previous = config.dataDir
  config.dataDir = await mkdtemp(join(tmpdir(), 'tmm-vanilla-'))
  try {
    const terraria = paths.terrariaInstall()
    const tml = paths.tmlInstall()
    await mkdir(terraria, { recursive: true })
    await writeFile(join(terraria, 'TerrariaServer.bin.x86_64'), '')
    await writeFile(join(terraria, '.tmodmanager-version'), '1.4.5.8\n')
    await mkdir(tml, { recursive: true })
    await writeFile(join(tml, 'start-tModLoaderServer.sh'), '')
    await writeFile(
      join(tml, 'tModLoader.dll'),
      Buffer.concat([Buffer.from('MZ 1.4.5.8', 'utf16le'), Buffer.from('FileVersion', 'utf16le'), Buffer.alloc(2), Buffer.from('1.4.4.9', 'utf16le'), Buffer.alloc(4)]),
    )

    const choices = await knownInstallations()
    assert.deepEqual(
      choices.map((c) => [c.kind, c.gameVersion, c.worldRelease]),
      [
        ['terraria', '1.4.5.8', 326],
        ['tshock', null, null],
        ['tmodloader', '1.4.4.9', 279],
      ],
    )

    await createServer({
      id: 'vanilla',
      name: 'Vanilla',
      installDir: terraria,
      port: 47_777,
      maxPlayers: 8,
      password: '',
      motd: '',
      world: { name: 'Mondo', size: 1, difficulty: 0, seed: '' },
      copyModsFrom: null,
      launchArgs: ['-nosteam'],
    })
    const [server] = await loadServers()
    assert.equal(server.game, 'terraria')

    // Il mondo salvato dal vanilla 1.4.5.8
    const world = join(paths.serverSave('vanilla'), 'Worlds', 'Mondo.wld')
    await writeFile(world, worldHeader(326))
    await writeFile(join(paths.serverSave('vanilla'), 'Worlds', 'Mondo.twld'), 'dati tModLoader')
    assert.equal((await serverSettings('vanilla')).worldRelease, 326)

    // Dopo uno spegnimento pulito si impara la versione con cui l'installazione salva
    await recordWorldRelease(server)
    assert.equal(await installationWorldRelease(terraria, null), 326)

    // Acceso: niente cambio di versione né ricreazione
    await assert.rejects(updateServer('vanilla', { installDir: tml }, managerIn('running')), ServerAdminError)
    await assert.rejects(recreateWorld('vanilla', managerIn('running')), ServerAdminError)

    // Cambio a tModLoader (permesso anche con un mondo più nuovo: l'avviso è compito del pannello)
    const switched = await updateServer('vanilla', { installDir: tml }, managerIn('stopped'))
    assert.equal(switched.game, 'tmodloader')
    assert.equal(switched.installDir, tml)
    assert.equal(await exists(join(paths.serverSave('vanilla'), 'Mods')), true)
    await assert.rejects(updateServer('vanilla', { installDir: '/non/esiste' }, managerIn('stopped')), ServerAdminError)

    // Ricreazione: mondo (e .twld) nel cestino, autocreate resta nel serverconfig
    const { trashed } = await recreateWorld('vanilla', managerIn('stopped'))
    assert.deepEqual(trashed.sort(), ['Mondo.twld', 'Mondo.wld'])
    assert.equal(await exists(world), false)
    const [after] = await loadServers()
    const items = await listTrash(after, ['file'])
    assert.deepEqual(items.map((i) => [i.root, i.path]).sort(), [
      ['save', join('Worlds', 'Mondo.twld')],
      ['save', join('Worlds', 'Mondo.wld')],
    ])
    assert.match(await readFile(after.configPath, 'utf8'), /^autocreate=1$/m)
  } finally {
    config.dataDir = previous
  }
})

test('serverconfig: chiavi avanzate lette, modificate e tolte; chiavi sconosciute rifiutate', async () => {
  const previous = config.dataDir
  config.dataDir = await mkdtemp(join(tmpdir(), 'tmm-config-'))
  try {
    const terraria = paths.terrariaInstall()
    await mkdir(terraria, { recursive: true })
    await writeFile(join(terraria, 'TerrariaServer.bin.x86_64'), '')
    await writeFile(join(terraria, '.tmodmanager-version'), '1.4.5.8\n')
    await createServer({
      id: 'cfg',
      name: 'Cfg',
      installDir: terraria,
      port: 47_778,
      maxPlayers: 8,
      password: 'segreta',
      motd: '',
      world: { name: 'Mondo', size: 2, difficulty: 3, seed: '' },
      copyModsFrom: null,
      launchArgs: ['-nosteam'],
    })
    const before = await serverSettings('cfg')
    assert.deepEqual(before.config, { autocreate: '2', worldname: 'Mondo', difficulty: '3' })
    assert.equal(JSON.stringify(before).includes('segreta'), false)

    const input = UpdateServerInput.parse({ config: { secure: '1', language: 'it-IT', journeypermission_godmode: '0', difficulty: null } })
    const after = await updateServer('cfg', input, managerIn('stopped'))
    assert.deepEqual(after.config, { autocreate: '2', worldname: 'Mondo', secure: '1', language: 'it-IT', journeypermission_godmode: '0' })
    assert.match(await readFile(paths.serverConfig('cfg'), 'utf8'), /^password=segreta$/m)

    assert.throws(() => UpdateServerInput.parse({ config: { world: '/etc/passwd' } }))
    assert.throws(() => UpdateServerInput.parse({ config: { secure: '1\nworld=/x' } }))
    assert.throws(() => UpdateServerInput.parse({ config: { journeypermission_godmode: '5' } }))
  } finally {
    config.dataDir = previous
  }
})

test('gioco non ancora installato: proposto alla creazione e al cambio di versione, installazione avviata', async () => {
  const previous = { dataDir: config.dataDir, terrariaApi: config.terrariaApi, githubApi: config.githubApi }
  config.dataDir = await mkdtemp(join(tmpdir(), 'tmm-autoinstall-'))
  // terraria.org e GitHub non raggiungibili: creazione e cambio riescono comunque e riportano il motivo
  config.terrariaApi = 'http://127.0.0.1:9'
  config.githubApi = 'http://127.0.0.1:9'
  try {
    const choices = await knownInstallations()
    assert.deepEqual(
      choices.map((c) => [c.kind, c.installed, c.installing]),
      [
        ['terraria', false, false],
        ['tshock', false, false],
        ['tmodloader', false, false],
      ],
    )
    const input = {
      id: 'nuovo',
      name: 'Nuovo',
      installDir: paths.terrariaInstall(),
      port: 47_779,
      maxPlayers: 8,
      password: '',
      motd: '',
      world: { name: 'Mondo', size: 1 as const, difficulty: 0 as const, seed: '' },
      copyModsFrom: null,
      launchArgs: ['-nosteam'],
    }
    // Senza manager (nessuna installazione possibile) un gioco mancante non si accetta
    await assert.rejects(createServer(input), ServerAdminError)

    const created = await createServer(input, managerIn('stopped'))
    assert.equal(created.install?.game, 'terraria')
    assert.match(created.install?.error ?? '', /terraria\.org/)
    const [server] = await loadServers()
    assert.equal(server.game, 'terraria')

    // Anche il cambio di versione accetta un gioco da installare (e prova a installarlo)
    const switched = await updateServer('nuovo', { installDir: paths.tmlInstall() }, managerIn('stopped'))
    assert.equal(switched.game, 'tmodloader')
    assert.equal(switched.install?.game, 'tmodloader')
    await assert.rejects(updateServer('nuovo', { installDir: '/non/esiste' }, managerIn('stopped')), ServerAdminError)
  } finally {
    Object.assign(config, previous)
  }
})

test('versioni aggiuntive di Terraria: elencate, scelte dai server, fisse, rimovibili se inutilizzate', async () => {
  const previous = { dataDir: config.dataDir, terrariaApi: config.terrariaApi }
  config.dataDir = await mkdtemp(join(tmpdir(), 'tmm-pinned-'))
  config.terrariaApi = 'http://127.0.0.1:9'
  const manager = { ...managerIn('stopped'), blockInstall: () => {}, unblockInstall: () => {} } as unknown as ServerManager
  try {
    const install = async (dir: string, version: string) => {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'TerrariaServer.bin.x86_64'), '')
      await writeFile(join(dir, '.tmodmanager-version'), `${version}\n`)
    }
    await install(paths.terrariaInstall(), '1.4.5.8')
    await install(paths.gameVersion('terraria', '1.4.4.9'), '1.4.4.9')

    const list = await listInstallations()
    assert.deepEqual(
      list.map((i) => [i.kind, i.version, i.pinned, i.managed]),
      [
        ['terraria', '1.4.5.8', false, true],
        ['terraria', '1.4.4.9', true, true],
        ['tshock', null, false, true],
        ['tmodloader', null, false, true],
      ],
    )
    const pinned = list[1]
    assert.equal(pinned.worldRelease, 279)
    assert.deepEqual(
      (await knownInstallations()).map((c) => [c.kind, c.version]),
      [
        ['terraria', '1.4.5.8'],
        ['terraria', '1.4.4.9'],
        ['tshock', null],
        ['tmodloader', null],
      ],
    )

    // Già presente tra le fisse (la stessa versione della principale invece si può aggiungere: la fissa non si aggiorna)
    await assert.rejects(addVersion('terraria', '1.4.4.9', manager), TmlError)
    // Fisse: niente aggiornamenti
    await assert.rejects(startJob(pinned, { version: '1.4.5.8' }, false, manager), TmlError)

    // Usata da un server: non si rimuove
    await createServer({
      id: 'vecchio',
      name: 'Vecchio',
      installDir: pinned.path,
      port: 47_780,
      maxPlayers: 8,
      password: '',
      motd: '',
      world: { name: 'Mondo', size: 1, difficulty: 0, seed: '' },
      copyModsFrom: null,
      launchArgs: ['-nosteam'],
    })
    await assert.rejects(removeInstallation(await findInstallation(pinned.id)), TmlError)
    await updateServer('vecchio', { installDir: paths.terrariaInstall() }, manager)
    await removeInstallation(await findInstallation(pinned.id))
    assert.equal(await exists(pinned.path), false)

    // Aggiunta non riuscita (terraria.org irraggiungibile): resta in elenco con l'errore, non si propone ai server
    await addVersion('terraria', '1.4.3.6', manager)
    const failed = async () => (await listInstallations()).find((i) => i.path === paths.gameVersion('terraria', '1.4.3.6'))
    for (let i = 0; i < 50 && (await failed())?.job?.phase !== 'error'; i++) await new Promise((r) => setTimeout(r, 50))
    const entry = await failed()
    assert.equal(entry?.job?.phase, 'error')
    assert.equal(entry?.installed, false)
    assert.equal((await knownInstallations()).some((c) => c.path === entry?.path), false)
    await removeInstallation(entry!)
    assert.equal(await failed(), undefined)
  } finally {
    Object.assign(config, previous)
  }
})

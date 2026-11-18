import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { config } from '../src/config.ts'
import { tshockDataDir, tshockPluginsDir } from '../src/games.ts'
import { isServerProcess, launchCommand, type ServerManager } from '../src/manager.ts'
import { paths } from '../src/paths.ts'
import { loadServers, ServerDefinition } from '../src/registry.ts'
import { createServer as createGameServer, ServerAdminError, serverSettings, stayOnVanilla, updateServer } from '../src/serverAdmin.ts'
import { findInstallation, hasDotnet, installationId, installationKind, listInstallations, parseTshockReleases, requiredDotnet, startJob } from '../src/tml.ts'
import { resetUpdateState, switchGame, updateNotices } from '../src/updates.ts'
import { writeZip } from '../src/zip.ts'

const run = promisify(execFile)

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

/** Risorsa di versione come negli assembly .NET (FileVersion in UTF-16). */
const versionInfo = (version: string) =>
  Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.from('FileVersion', 'utf16le'), Buffer.alloc(2), Buffer.from(version, 'utf16le'), Buffer.alloc(4)])

/** Installazione finta di TShock: eseguibile, TShockAPI.dll e OTAPI.dll con le loro versioni. */
async function fakeTshock(dir: string, tshock: string, terraria: string) {
  await mkdir(join(dir, 'ServerPlugins'), { recursive: true })
  await mkdir(join(dir, 'bin'), { recursive: true })
  await writeFile(join(dir, 'TShock.Server'), Buffer.concat([Buffer.from('\x7fELF...'), Buffer.from('{"runtimeOptions":{"tfm": "net9.0"}}')]))
  await writeFile(join(dir, 'ServerPlugins', 'TShockAPI.dll'), versionInfo(`${tshock}.0`))
  await writeFile(join(dir, 'bin', 'OTAPI.dll'), versionInfo(terraria))
}

async function fakeTerraria(dir: string, version: string) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'TerrariaServer.bin.x86_64'), '')
  await writeFile(join(dir, '.tmodmanager-version'), `${version}\n`)
}

/** Manager finto: server sempre spenti, operazioni registrate. */
function fakeManager() {
  const calls: string[] = []
  const manager = {
    status: async () => ({ state: 'stopped', operation: null, managed: false }),
    runBlocking: async (server: { id: string }, op: string) => {
      calls.push(`${op}:${server.id}`)
    },
    blockInstall: () => {},
    unblockInstall: () => {},
    blockServer: () => {},
    unblockServer: () => {},
  } as unknown as ServerManager
  return { manager, calls }
}

const RELEASES = [
  {
    tag_name: 'v6.2.1',
    name: 'TShock 6.2.1 for Terraria 1.4.5.8',
    draft: false,
    prerelease: false,
    published_at: '2026-09-27T14:57:16Z',
    html_url: 'https://github.com/Pryaxis/TShock/releases/tag/v6.2.1',
    assets: [
      { name: 'TShock-6.2.1-for-Terraria-1.4.5.8-linux-arm64-Release.zip', size: 1, browser_download_url: 'https://x/arm64.zip' },
      { name: 'TShock-6.2.1-for-Terraria-1.4.5.8-linux-x64-Release.zip', size: 34419595, browser_download_url: 'https://x/x64.zip', digest: 'sha256:abc' },
      { name: 'TShock-6.2.1-for-Terraria-1.4.5.8-win-x64-Release.zip', size: 1, browser_download_url: 'https://x/win.zip' },
    ],
  },
  {
    tag_name: 'v6.0.0-pre3',
    name: 'TShock 6 for Terraria 1.4.5.5 Pre-release 2 (B) (.NET 9)',
    draft: false,
    prerelease: true,
    published_at: '2026-03-07T06:49:18Z',
    html_url: 'https://github.com/Pryaxis/TShock/releases/tag/v6.0.0-pre3',
    assets: [{ name: 'TShock-Beta-linux-x64-Release.zip', size: 2, browser_download_url: 'https://x/beta.zip' }],
  },
  { tag_name: 'v5.0.0', name: 'senza zip linux', draft: false, prerelease: false, published_at: '', html_url: '', assets: [] },
]

test('release di TShock: zip linux-x64, versione di Terraria dal titolo, beta riconosciute', () => {
  const releases = parseTshockReleases(RELEASES, 'linux-x64')
  assert.deepEqual(
    releases.map((r) => [r.version, r.gameVersion, r.prerelease, r.downloadUrl, r.sha256, r.worldRelease]),
    [
      ['6.2.1', '1.4.5.8', false, 'https://x/x64.zip', 'abc', 326],
      ['6.0.0-pre3', '1.4.5.5', true, 'https://x/beta.zip', null, 318],
    ],
  )
  assert.equal(parseTshockReleases(RELEASES, 'linux-arm64')[0].downloadUrl, 'https://x/arm64.zip')
})

test('installazione di TShock: riconosciuta dai file, versione di TShock e di Terraria dagli assembly, runtime .NET richiesto', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmm-tshock-'))
  assert.equal(await installationKind(join(dir, 'TShock')), 'tshock') // non ancora installata: dal nome
  await fakeTshock(dir, '6.2.1', '1.4.5.8')
  assert.equal(await installationKind(dir), 'tshock')
  assert.equal(await requiredDotnet(dir), '9.0')
  assert.equal(await hasDotnet(dir, '9.0'), false)
  await mkdir(join(dir, 'dotnet', 'shared', 'Microsoft.NETCore.App', '9.0.23'), { recursive: true })
  await writeFile(join(dir, 'dotnet', 'dotnet'), '')
  assert.equal(await hasDotnet(dir, '9.0'), true)
  assert.equal(await hasDotnet(dir, '10.0'), false)

  const previous = config.dataDir
  config.dataDir = await mkdtemp(join(tmpdir(), 'tmm-tshock-list-'))
  try {
    await fakeTshock(paths.tshockInstall(), '6.2.1', '1.4.5.8')
    const tshock = (await listInstallations()).find((i) => i.kind === 'tshock')
    assert.deepEqual([tshock?.installed, tshock?.version, tshock?.gameVersion, tshock?.worldRelease], [true, '6.2.1', '1.4.5.8', 326])
  } finally {
    config.dataDir = previous
  }
})

test('avvio di TShock: porta e giocatori da riga di comando, dati e plugin nel save/ del server, runtime .NET', () => {
  const server = ServerDefinition.parse({ id: 't', name: 'T', game: 'tshock', installDir: '/i', saveDir: '/s', configFile: '/c/serverconfig.txt' })
  const { command, env } = launchCommand(server, { port: 7780, maxPlayers: 12 })
  assert.deepEqual(command, [
    './TShock.Server',
    '-config', '/c/serverconfig.txt',
    '-port', '7780',
    '-maxplayers', '12',
    '-configpath', '/s/tshock',
    '-logpath', '/s/tshock/logs',
    '-additionalplugins', '/s/ServerPlugins',
    '-noupnp',
  ])
  assert.deepEqual(env, { DOTNET_ROOT: '/i/dotnet' })

  const proc = (args: string[]) => ({ pid: 1, ppid: 0, cpuTicks: 0, startTicks: 0, args })
  assert.equal(isServerProcess(proc(command), server), true)
  assert.equal(isServerProcess(proc(['SCREEN', '-c', '/rc', '-dmS', 'tml-t', ...command]), server), false)
  // Lo stesso serverconfig con il server vanilla non è TShock
  assert.equal(isServerProcess(proc(['./TerrariaServer.bin.x86_64', '-config', '/c/serverconfig.txt']), server), false)
})

test('TShock ↔ vanilla: stesso mondo, dati di TShock e plugin restano; proposta di ritorno su TShock', async () => {
  const previous = config.dataDir
  config.dataDir = await mkdtemp(join(tmpdir(), 'tmm-tshock-switch-'))
  const { manager } = fakeManager()
  try {
    await fakeTshock(paths.tshockInstall(), '6.2.1', '1.4.5.8')
    await fakeTerraria(paths.terrariaInstall(), '1.4.5.8')
    await createGameServer({
      id: 'plug',
      name: 'Plugin',
      installDir: paths.tshockInstall(),
      port: 7790,
      maxPlayers: 8,
      password: '',
      motd: '',
      world: { name: 'Mondo', size: 1, difficulty: 0, seed: '' },
      copyModsFrom: null,
      launchArgs: [],
    })
    const save = paths.serverSave('plug')
    assert.equal(await exists(tshockPluginsDir(save)), true)
    // Dati scritti da TShock e un plugin caricato dall'utente
    await writeFile(join(tshockDataDir(save), 'config.json'), '{"Settings":{}}')
    await writeFile(join(tshockDataDir(save), 'tshock.sqlite'), 'db')
    await writeFile(join(tshockPluginsDir(save), 'Essentials.dll'), 'plugin')

    const vanilla = await updateServer('plug', { installDir: paths.terrariaInstall() }, manager)
    assert.equal(vanilla.game, 'terraria')
    assert.equal(vanilla.awaitingTshock, true)
    assert.equal(vanilla.tshockData, tshockDataDir(save))
    assert.equal(await readFile(join(tshockPluginsDir(save), 'Essentials.dll'), 'utf8'), 'plugin')

    // Un'altra versione di Terraria lascia la proposta aperta; "resta su vanilla" la chiude
    await fakeTerraria(paths.terrariaVersion('1.4.5.9'), '1.4.5.9')
    assert.equal((await updateServer('plug', { installDir: paths.terrariaVersion('1.4.5.9') }, manager)).awaitingTshock, true)
    await stayOnVanilla('plug')
    assert.equal((await serverSettings('plug')).awaitingTshock, false)

    const back = await updateServer('plug', { installDir: paths.tshockInstall() }, manager)
    assert.equal(back.game, 'tshock')
    assert.equal(back.awaitingTshock, false)
    assert.equal(await readFile(join(tshockDataDir(save), 'tshock.sqlite'), 'utf8'), 'db')
  } finally {
    config.dataDir = previous
  }
})

test('avvisi: aggiornamenti, Terraria uscito prima di TShock, TShock pronto per i server passati a vanilla', async () => {
  const previous = config.dataDir
  config.dataDir = await mkdtemp(join(tmpdir(), 'tmm-tshock-notices-'))
  const writeCheck = async (latest: object) => {
    resetUpdateState()
    await writeFile(paths.updateCheck(), JSON.stringify({ checkedAt: new Date().toISOString(), latest, errors: {} }))
  }
  const terraria = (version: string) => ({ version, gameVersion: version, url: '', publishedAt: null, worldRelease: null })
  const tshock = (version: string, game: string) => ({ version, gameVersion: game, url: 'https://tshock', publishedAt: null, worldRelease: null })
  try {
    await fakeTshock(paths.tshockInstall(), '6.2.1', '1.4.5.8')
    await fakeTerraria(paths.terrariaInstall(), '1.4.5.8')
    await writeFile(
      paths.registry(),
      JSON.stringify({
        servers: [
          { id: 'ts', name: 'Con plugin', game: 'tshock', installDir: paths.tshockInstall(), saveDir: join(config.dataDir, 'ts') },
          { id: 'va', name: 'Vanilla', game: 'terraria', installDir: paths.terrariaInstall(), saveDir: join(config.dataDir, 'va') },
        ],
      }),
    )

    // Tutto aggiornato
    await writeCheck({ terraria: terraria('1.4.5.8'), tshock: tshock('6.2.1', '1.4.5.8') })
    assert.deepEqual((await updateNotices()).notices, [])

    // Esce Terraria 1.4.5.9, TShock no
    await writeCheck({ terraria: terraria('1.4.5.9'), tshock: tshock('6.2.1', '1.4.5.8') })
    const behind = (await updateNotices()).notices
    assert.deepEqual(
      behind.map((n) => [n.type, n.id]),
      [
        ['update', `update:${installationId(paths.terrariaInstall())}:1.4.5.9`],
        ['tshock-behind', 'tshock-behind:1.4.5.9'],
      ],
    )
    const notice = behind[1]
    assert.ok(notice.type === 'tshock-behind')
    assert.equal(notice.tshockGameVersion, '1.4.5.8')
    assert.deepEqual(notice.servers, [{ id: 'ts', name: 'Con plugin' }])

    // Il server TShock passa a vanilla 1.4.5.9: aspetta TShock, che non c'è ancora
    await fakeTerraria(paths.terrariaVersion('1.4.5.9'), '1.4.5.9')
    await writeFile(
      paths.registry(),
      JSON.stringify({
        servers: [
          {
            id: 'ts',
            name: 'Con plugin',
            game: 'terraria',
            awaitingTshock: true,
            installDir: paths.terrariaVersion('1.4.5.9'),
            saveDir: join(config.dataDir, 'ts'),
          },
        ],
      }),
    )
    assert.deepEqual((await updateNotices()).notices.map((n) => n.type), ['update'])

    // Esce TShock 6.3.0 per Terraria 1.4.5.9: aggiornamento di TShock e proposta di tornarci
    await writeCheck({ terraria: terraria('1.4.5.9'), tshock: tshock('6.3.0', '1.4.5.9') })
    const ready = (await updateNotices()).notices
    assert.deepEqual(ready.map((n) => n.type), ['update', 'update', 'tshock-ready'])
    const back = ready[2]
    assert.ok(back.type === 'tshock-ready')
    assert.deepEqual([back.server.id, back.serverGameVersion, back.tshockVersion, back.needsUpdate], ['ts', '1.4.5.9', '6.3.0', true])
  } finally {
    resetUpdateState()
    config.dataDir = previous
  }
})

test('passaggio guidato: a Terraria vanilla già installato, rifiutato verso lo stesso gioco', async () => {
  const previous = config.dataDir
  config.dataDir = await mkdtemp(join(tmpdir(), 'tmm-tshock-guided-'))
  const { manager } = fakeManager()
  try {
    resetUpdateState()
    await fakeTshock(paths.tshockInstall(), '6.2.1', '1.4.5.8')
    await fakeTerraria(paths.terrariaInstall(), '1.4.5.9')
    await writeFile(paths.updateCheck(), JSON.stringify({ checkedAt: new Date().toISOString(), latest: { terraria: { version: '1.4.5.9' } }, errors: {} }))
    await writeFile(
      paths.registry(),
      JSON.stringify({ servers: [{ id: 'ts', name: 'Con plugin', game: 'tshock', installDir: paths.tshockInstall(), saveDir: join(config.dataDir, 'ts') }] }),
    )

    await assert.rejects(switchGame('ts', 'tshock', manager), ServerAdminError)
    const job = await switchGame('ts', 'terraria', manager)
    assert.equal(job.version, '1.4.5.9')
    for (let i = 0; i < 50 && job.phase !== 'done' && job.phase !== 'error'; i++) await sleep(20)
    assert.equal(job.phase, 'done', job.error ?? '')
    const [server] = await loadServers()
    assert.deepEqual([server.game, server.installDir, server.awaitingTshock], ['terraria', paths.terrariaInstall(), true])
    assert.deepEqual((await updateNotices()).switches.map((s) => [s.serverId, s.phase]), [['ts', 'done']])
  } finally {
    resetUpdateState()
    config.dataDir = previous
  }
})

/** Server HTTP locale con le risposte date (path → corpo). */
async function serve(routes: Record<string, Buffer | string | object>): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const body = routes[req.url ?? '']
    if (body === undefined) {
      res.statusCode = 404
      return res.end()
    }
    if (Buffer.isBuffer(body) || typeof body === 'string') return res.end(body)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
}

test('installazione di TShock: zip con .tar dentro, runtime .NET scaricato e verificato (sha512)', async () => {
  const previous = { dataDir: config.dataDir, githubApi: config.githubApi, dotnetReleases: config.dotnetReleases }
  config.dataDir = await mkdtemp(join(tmpdir(), 'tmm-tshock-install-'))
  const work = await mkdtemp(join(tmpdir(), 'tmm-tshock-release-'))
  const { manager } = fakeManager()
  let http: Server | null = null
  try {
    // Release: zip → TShock-Beta-linux-x64-Release.tar → installazione
    const content = join(work, 'content')
    await fakeTshock(content, '6.2.1', '1.4.5.8')
    await run('tar', ['-cf', join(work, 'TShock-Beta-linux-x64-Release.tar'), '-C', content, '.'])
    await writeZip(join(work, 'release.zip'), [{ name: 'TShock-Beta-linux-x64-Release.tar', path: join(work, 'TShock-Beta-linux-x64-Release.tar') }])
    // Runtime .NET finto
    const runtime = join(work, 'runtime')
    await mkdir(join(runtime, 'shared', 'Microsoft.NETCore.App', '9.0.23'), { recursive: true })
    await writeFile(join(runtime, 'dotnet'), '')
    await run('tar', ['-czf', join(work, 'dotnet.tar.gz'), '-C', runtime, '.'])
    const runtimeArchive = await readFile(join(work, 'dotnet.tar.gz'))
    const zip = await readFile(join(work, 'release.zip'))

    const rid = process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
    const routes: Record<string, Buffer | string | object> = { '/release.zip': zip, '/dotnet.tar.gz': runtimeArchive }
    const { url, server } = await serve(routes)
    http = server
    routes['/repos/Pryaxis/TShock/releases?per_page=15'] = [
      {
        ...RELEASES[0],
        assets: [{ name: `TShock-6.2.1-for-Terraria-1.4.5.8-${rid}-Release.zip`, size: zip.length, browser_download_url: `${url}/release.zip`, digest: `sha256:${createHash('sha256').update(zip).digest('hex')}` }],
      },
    ]
    routes['/9.0/releases.json'] = {
      'latest-runtime': '9.0.23',
      releases: [
        {
          runtime: {
            version: '9.0.23',
            files: [{ name: `dotnet-runtime-${rid}.tar.gz`, rid, url: `${url}/dotnet.tar.gz`, hash: createHash('sha512').update(runtimeArchive).digest('hex') }],
          },
        },
      ],
    }
    config.githubApi = url
    config.dotnetReleases = url

    const installation = await findInstallation(installationId(paths.tshockInstall()))
    assert.equal(installation.installed, false)
    const job = await startJob(installation, { version: '6.2.1' }, false, manager)
    for (let i = 0; i < 250 && job.phase !== 'done' && job.phase !== 'error'; i++) await sleep(20)
    assert.equal(job.phase, 'done', job.error ?? '')

    const installed = await findInstallation(installationId(paths.tshockInstall()))
    assert.deepEqual([installed.kind, installed.version, installed.gameVersion], ['tshock', '6.2.1', '1.4.5.8'])
    assert.equal(await hasDotnet(paths.tshockInstall(), '9.0'), true)

    // Runtime con hash sbagliato: l'installazione fallisce
    ;(routes['/9.0/releases.json'] as { releases: { runtime: { files: { hash: string }[] } }[] }).releases[0].runtime.files[0].hash = 'ff'
    config.dataDir = await mkdtemp(join(tmpdir(), 'tmm-tshock-badhash-'))
    const failing = await startJob(await findInstallation(installationId(paths.tshockInstall())), { version: '6.2.1' }, false, manager)
    for (let i = 0; i < 250 && failing.phase !== 'done' && failing.phase !== 'error'; i++) await sleep(20)
    assert.equal(failing.phase, 'error')
    assert.match(failing.error ?? '', /sha512/)
    assert.equal(await exists(join(paths.tshockInstall(), 'TShock.Server')), false)
  } finally {
    http?.close()
    Object.assign(config, previous)
  }
})

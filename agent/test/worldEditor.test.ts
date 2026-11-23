import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { config } from '../src/config.ts'
import { ServerDefinition } from '../src/registry.ts'
import { changeWorldSettings, editWorld, undoWorldEdit, WorldEditorError, worldEditorAvailable, worldEditorCatalog, worldSettings } from '../src/worldEditor.ts'

async function setup(game: 'tmodloader' | 'tshock' = 'tmodloader') {
  config.dataDir = await mkdtemp(join(tmpdir(), 'tmm-editor-'))
  const save = join(config.dataDir, 'servers', 'm', 'save')
  await mkdir(save, { recursive: true })
  const server = ServerDefinition.parse({ id: 'm', name: 'M', game, installDir: join(config.dataDir, 'i'), saveDir: save, configFile: join(save, 'serverconfig.txt') })
  const dir = join(save, 'LiveMap', 'editor')
  return { server, dir }
}

/** Come la mod: risponde al primo comando che compare in inbox. */
async function respond(dir: string, result: object) {
  for (let i = 0; i < 100; i++) {
    const files = (await readdir(join(dir, 'inbox')).catch(() => [])).filter((f) => f.endsWith('.json'))
    if (files.length) {
      const command = JSON.parse(await readFile(join(dir, 'inbox', files[0]), 'utf8'))
      await rm(join(dir, 'inbox', files[0]))
      await mkdir(join(dir, 'outbox'), { recursive: true })
      await writeFile(join(dir, 'outbox', 'x.tmp'), JSON.stringify(result))
      await rename(join(dir, 'outbox', 'x.tmp'), join(dir, 'outbox', files[0]))
      return command
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('nessun comando')
}

test("editor: disponibile solo se la mod tocca alive di recente, e solo con tModLoader", async () => {
  const { server, dir } = await setup()
  assert.equal(await worldEditorAvailable(server), false)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'alive'), '1\n')
  assert.equal(await worldEditorAvailable(server), true)
  const old = new Date(Date.now() - 60_000)
  await utimes(join(dir, 'alive'), old, old)
  assert.equal(await worldEditorAvailable(server), false)

  const tshock = await setup('tshock')
  assert.equal(await worldEditorAvailable(tshock.server), false)
})

test('editor: il comando arriva alla mod e torna il suo esito', async () => {
  const { server, dir } = await setup()
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'alive'), '1\n')
  const result = { applied: 1, failed: 1, failures: [{ index: 1, x: 5, y: 6, reason: 'occupata' }] }
  const [edited, command] = await Promise.all([
    editWorld(server, { ops: [{ op: 'kill-tile', x: 100, y: 200 }, { op: 'place-tile', x: 5, y: 6, type: 1 }] }),
    respond(dir, result),
  ])
  assert.deepEqual(edited, result)
  assert.equal(command.ops[1].style, 0)
  assert.ok(Math.abs(command.createdAt - Date.now()) < 5000)
  assert.deepEqual(await readdir(join(dir, 'outbox')), [], "l'esito letto si cancella")
})

test('editor: modifiche non valide, editor spento', async () => {
  const { server, dir } = await setup()
  await assert.rejects(editWorld(server, { ops: [{ op: 'kill-tile', x: 1, y: 1 }] }), (e: WorldEditorError) => e.code === 'unavailable')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'alive'), '1\n')
  await assert.rejects(editWorld(server, { ops: [] }), (e: WorldEditorError) => e.code === 'invalid')
  await assert.rejects(editWorld(server, { ops: [{ op: 'explode', x: 1, y: 1 }] }), (e: WorldEditorError) => e.code === 'invalid')
  await assert.rejects(editWorld(server, { ops: [{ op: 'place-wall', x: 1, y: 1, type: 0 }] }), (e: WorldEditorError) => e.code === 'invalid')
})

test('editor: catalogo dei blocchi scritto dalla mod', async () => {
  const { server, dir } = await setup()
  assert.equal(await worldEditorCatalog(server), null)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'catalog.json'), JSON.stringify({ format: 1, tiles: [{ type: 0, name: 'Dirt' }, { type: 700, name: 'Foo', mod: 'M', object: true }], walls: [] }))
  const catalog = await worldEditorCatalog(server)
  assert.equal(catalog?.tiles[1].mod, 'M')
})

test('settaggi del mondo: stato letto dalla mod, cambiamenti validati e mandati come comando', async () => {
  const { server, dir } = await setup()
  await mkdir(dir, { recursive: true })
  const state = {
    clock: 720, day: true, rain: false, sandstorm: false, bloodMoon: false, eclipse: false, moonPhase: 0, gameMode: 1, hardMode: false,
    generatingHardMode: false, spawnX: 4200, spawnY: 400, bosses: { eyeOfCthulhu: true },
  }
  await writeFile(join(dir, 'world.json'), JSON.stringify(state))
  assert.equal(await worldSettings(server), null, 'editor spento: niente settaggi (sarebbero vecchi)')
  await writeFile(join(dir, 'alive'), '1\n')
  assert.deepEqual(await worldSettings(server), state)

  const result = { applied: 1, failed: 1, failures: [{ index: -1, x: 0, y: 0, reason: 'solo di notte', setting: 'bloodMoon' }] }
  const [changed, command] = await Promise.all([
    changeWorldSettings(server, { clock: 1200, bloodMoon: true, spawn: { x: 100, y: 200 }, bosses: { plantera: true } }),
    respond(dir, result),
  ])
  assert.deepEqual(changed, result)
  assert.deepEqual(command.settings, { clock: 1200, bloodMoon: true, spawnX: 100, spawnY: 200, bosses: { plantera: true } })

  for (const invalid of [{}, { clock: 1440 }, { gameMode: 3 }, { bosses: { wallOfFlesh: true } }, { bosses: { foo: true } }, { weather: 'storm' }]) {
    await assert.rejects(changeWorldSettings(server, invalid), (e: WorldEditorError) => e.code === 'invalid', JSON.stringify(invalid))
  }
})

test("annulla: l'id del comando torna nell'esito e si rimanda alla mod; id non validi rifiutati", async () => {
  const { server, dir } = await setup()
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'alive'), '1\n')
  const id = '1763650000000-0123abcd-4567-89ab-cdef-0123456789ab'
  const result = { applied: 9, failed: 1, failures: [{ index: -1, x: 4, y: 5, reason: 'changed since' }] }
  const [undone, command] = await Promise.all([undoWorldEdit(server, { id }), respond(dir, result)])
  assert.deepEqual(undone, result)
  assert.equal(command.undo, id)

  for (const invalid of [{}, { id: '../../etc' }, { id: 'abc' }, { id: 12 }]) {
    await assert.rejects(undoWorldEdit(server, invalid), (e: WorldEditorError) => e.code === 'invalid', JSON.stringify(invalid))
  }
})

test("annulla: errore della mod (modifica troppo vecchia) come errore dell'editor", async () => {
  const { server, dir } = await setup()
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'alive'), '1\n')
  const id = '1763650000000-0123abcd-4567-89ab-cdef-0123456789ab'
  const [outcome] = await Promise.allSettled([undoWorldEdit(server, { id }), respond(dir, { applied: 0, failed: 0, failures: [], error: 'this change can no longer be undone' })])
  assert.equal(outcome.status, 'rejected')
  assert.equal((outcome as PromiseRejectedResult).reason.code, 'invalid')
})

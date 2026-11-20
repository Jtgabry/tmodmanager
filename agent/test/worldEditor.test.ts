import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { config } from '../src/config.ts'
import { ServerDefinition } from '../src/registry.ts'
import { editWorld, WorldEditorError, worldEditorAvailable, worldEditorCatalog } from '../src/worldEditor.ts'

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

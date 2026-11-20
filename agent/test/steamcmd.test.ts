import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// steamcmd finto: annuncia il download e poi resta fermo in un processo figlio (come steamcmd.sh col vero steamcmd)
const dir = await mkdtemp(join(tmpdir(), 'steamcmd-test-'))
const script = join(dir, 'steamcmd.sh')
await writeFile(script, `#!/bin/sh\necho 'Downloading item 111 ...'\nsleep 30 &\necho $! > "${dir}/child.pid"\nwait\n`)
await chmod(script, 0o755)
process.env.AGENT_STEAMCMD = script
process.env.AGENT_DATA_DIR = dir
const { steamcmdDownloadAll } = await import('../src/workshop.ts')

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('annullare un download ferma steamcmd e i suoi processi figli', async () => {
  const controller = new AbortController()
  const errors: [string, string][] = []
  const started: string[] = []
  const run = steamcmdDownloadAll(
    ['111', '222'],
    {
      onStart: (id) => {
        started.push(id)
        setTimeout(() => controller.abort(), 100)
      },
      onProgress: () => {},
      onDone: () => assert.fail('nessun download deve finire'),
      onError: (id, message) => errors.push([id, message]),
    },
    controller.signal,
  )
  const t0 = Date.now()
  await run
  assert.ok(Date.now() - t0 < 5000)
  assert.deepEqual(started, ['111'])
  assert.deepEqual(errors.sort(), [
    ['111', 'Download cancelled'],
    ['222', 'Download cancelled'],
  ])
  const pid = Number(await readFile(join(dir, 'child.pid'), 'utf8'))
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(alive(pid), false)
})

test('un download annullato prima di partire non avvia steamcmd', async () => {
  const controller = new AbortController()
  controller.abort()
  const errors: string[] = []
  await steamcmdDownloadAll(['333'], { onStart: () => assert.fail(), onProgress: () => {}, onDone: () => assert.fail(), onError: (id) => errors.push(id) }, controller.signal)
  assert.deepEqual(errors, ['333'])
})

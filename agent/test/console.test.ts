import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

const dir = await mkdtemp(join(tmpdir(), 'tmm-console-'))
process.env.AGENT_DATA_DIR = dir

const { readConsole, validateCommand, consoleLogPath } = await import('../src/console.ts')
const { escapeStuff } = await import('../src/screen.ts')
const { mkdir } = await import('node:fs/promises')

const server = { id: 'demo' } as Parameters<typeof readConsole>[0]

test('escapeStuff rende letterali ^, \\ e $', () => {
  assert.equal(escapeStuff('say ^C \\n $HOME'), 'say \\^C \\\\n \\$HOME')
  assert.equal(escapeStuff('normale àè'), 'normale àè')
})

test('validateCommand rifiuta vuoti, troppo lunghi e caratteri di controllo', () => {
  assert.equal(validateCommand('  say ciao  '), 'say ciao')
  assert.throws(() => validateCommand('   '))
  assert.throws(() => validateCommand('a'.repeat(501)))
  assert.throws(() => validateCommand('save\nexit'))
  assert.throws(() => validateCommand('x\u001b[2J'))
  assert.throws(() => validateCommand(42))
})

test('readConsole legge in modo incrementale e segnala il reset dopo la rotazione', async () => {
  await mkdir(dirname(consoleLogPath(server)), { recursive: true })
  await writeFile(consoleLogPath(server), 'riga 1\nriga 2\n')

  const first = await readConsole(server)
  assert.deepEqual(first, { offset: 14, data: 'riga 1\nriga 2\n', reset: true })

  await writeFile(consoleLogPath(server), 'riga 1\nriga 2\nriga 3 àè\n')
  const next = await readConsole(server, first.offset)
  assert.equal(next.data, 'riga 3 àè\n')
  assert.equal(next.reset, false)

  const idle = await readConsole(server, next.offset)
  assert.deepEqual(idle, { offset: next.offset, data: '', reset: false })

  await writeFile(consoleLogPath(server), 'nuova sessione\n')
  const rotated = await readConsole(server, next.offset)
  assert.equal(rotated.reset, true)
  assert.equal(rotated.data, 'nuova sessione\n')
})

test('readConsole senza log restituisce vuoto', async () => {
  const missing = { id: 'nessuno' } as Parameters<typeof readConsole>[0]
  assert.deepEqual(await readConsole(missing), { offset: 0, data: '', reset: false })
})

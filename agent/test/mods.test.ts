import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { dependencyClosure, enabledDependents } from '../src/mods.ts'
import { readModInfo, sideName, TmodError } from '../src/tmod.ts'

/** Stringa .NET: lunghezza 7-bit + UTF-8 */
const str = (s: string) => {
  const bytes = Buffer.from(s, 'utf8')
  const len: number[] = []
  let n = bytes.length
  do {
    len.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0))
    n >>= 7
  } while (n > 0)
  return Buffer.concat([Buffer.from(len), bytes])
}
const i32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeInt32LE(n)
  return b
}

/** Costruisce un .tmod minimale con un file grosso prima di Info (Info compresso). */
function buildTmod(name: string, version: string) {
  const info = Buffer.concat([
    str('modReferences'), str('CalamityMod@2.0.4'), str('Luminance'), str(''),
    str('weakReferences'), str('SubworldLibrary'), str(''),
    str('author'), str('Autore'),
    str('version'), str(version),
    str('displayName'), str('Mod di prova àè'),
    str('!hideCode'),
    str('side'), Buffer.from([2]),
    str(''),
  ])
  const infoCompressed = deflateRawSync(info)
  const big = Buffer.alloc(300_000, 7)
  const data = Buffer.concat([
    str(name), str(version), i32(2),
    str('Assets/big.rawimg'), i32(big.length), i32(big.length),
    str('Info'), i32(info.length), i32(infoCompressed.length),
    big, infoCompressed,
  ])
  return Buffer.concat([Buffer.from('TMOD'), str('2026.9.3.1'), Buffer.alloc(20), Buffer.alloc(256), i32(data.length), data])
}

const dir = await mkdtemp(join(tmpdir(), 'tmm-tmod-'))

test('readModInfo legge intestazione e Info (compresso, dopo altri file)', async () => {
  const path = join(dir, 'Demo.tmod')
  await writeFile(path, buildTmod('Demo_Mod', '1.2.3'))
  const info = await readModInfo(path)
  assert.equal(info.name, 'Demo_Mod')
  assert.equal(info.version, '1.2.3')
  assert.equal(info.tmlVersion, '2026.9.3.1')
  assert.equal(info.displayName, 'Mod di prova àè')
  assert.equal(info.author, 'Autore')
  assert.deepEqual(info.modReferences, ['CalamityMod', 'Luminance'])
  assert.deepEqual(info.weakReferences, ['SubworldLibrary'])
  assert.equal(sideName(info.side), 'server')
})

test('readModInfo rifiuta file non .tmod e nomi interni pericolosi', async () => {
  const notTmod = join(dir, 'x.tmod')
  await writeFile(notTmod, 'ciao')
  await assert.rejects(readModInfo(notTmod), TmodError)

  const evil = join(dir, 'evil.tmod')
  await writeFile(evil, buildTmod('../../etc', '1.0'))
  await assert.rejects(readModInfo(evil), /Nome interno/)
})

test('dependencyClosure e enabledDependents seguono le dipendenze indirette', () => {
  const graph = new Map([
    ['Infernum', ['Calamity', 'Luminance']],
    ['Calamity', ['CalamityMusic']],
    ['CalamityMusic', []],
    ['Luminance', []],
    ['Altro', []],
  ])
  assert.deepEqual([...dependencyClosure(graph, ['Infernum'])].sort(), ['Calamity', 'CalamityMusic', 'Infernum', 'Luminance'])
  assert.deepEqual(enabledDependents(graph, ['Infernum', 'Calamity', 'CalamityMusic', 'Altro'], 'CalamityMusic'), ['Calamity', 'Infernum'])
  assert.deepEqual(enabledDependents(graph, ['Altro', 'Luminance'], 'Luminance'), [])
})

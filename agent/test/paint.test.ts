import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mapPaint } from '../src/paint.ts'

test('vernice sulla minimappa: come MapHelper.MapColor', () => {
  // Normale: il colore della vernice per il canale più chiaro del blocco
  assert.equal(mapPaint(0x808080, 1, false), 0x800000)
  assert.equal(mapPaint(0x204080, 5, false), 0x008000)
  // Ombra: molto scuro, dal canale rimasto in fondo dopo gli scambi
  assert.equal(mapPaint(0xc86432, 29, false), 0x010101)
  // Negativa: colori invertiti, a metà per i muri
  assert.equal(mapPaint(0x102030, 30, false), 0xefdfcf)
  assert.equal(mapPaint(0x102030, 30, true), 0x776f67)
  // Nessuna vernice o numero sconosciuto: il colore resta
  assert.equal(mapPaint(0x123456, 0, false), 0x123456)
  assert.equal(mapPaint(0x123456, 99, false), 0x123456)
})

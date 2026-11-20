import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import Fastify from 'fastify'
import { currentLocale, localeFrom, tr, trText, withLocale } from '../src/i18n.ts'
import it from '../src/i18n/it.ts'

test('lingua da Accept-Language: italiano solo se è la prima scelta, altrimenti inglese', () => {
  assert.equal(localeFrom('it'), 'it')
  assert.equal(localeFrom('it-IT,it;q=0.9,en;q=0.8'), 'it')
  assert.equal(localeFrom('en-US,it;q=0.5'), 'en')
  assert.equal(localeFrom('de'), 'en')
  assert.equal(localeFrom(undefined), 'en')
})

test('senza richiesta i messaggi sono in inglese, con i segnaposto sostituiti', () => {
  assert.equal(currentLocale(), 'en')
  assert.equal(tr('Server not found'), 'Server not found')
  assert.equal(tr('Starting {server}…', { server: 'Alfa' }), 'Starting Alfa…')
})

test('la lingua vale anche per il lavoro asincrono avviato dentro withLocale', async () => {
  const message = await withLocale('it', async () => {
    await sleep(5)
    return tr('Starting {server}…', { server: 'Alfa' })
  })
  assert.equal(message, 'Avvio di Alfa…')
  assert.equal(tr('Server not found'), 'Server not found')
})

test('testi esterni (motivi della mod LiveMap): tradotti se noti, altrimenti invariati', () => {
  withLocale('it', () => {
    assert.equal(trText('outside the world'), 'fuori dal mondo')
    assert.equal(trText('error: boom'), 'error: boom')
  })
})

test('ogni traduzione italiana ha gli stessi segnaposto del testo inglese', () => {
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
  for (const [key, value] of Object.entries(it)) assert.deepEqual(placeholders(value), placeholders(key), key)
})

test('con l\'hook dell\'agent gli errori di una richiesta arrivano nella sua lingua', async () => {
  const app = Fastify()
  app.addHook('onRequest', (req, _reply, done) => withLocale(localeFrom(req.headers['accept-language']), done))
  app.addHook('onRequest', async () => {
    await sleep(1)
  })
  app.get('/', async () => {
    await sleep(1)
    throw Object.assign(new Error(tr('Server not found')), { statusCode: 404 })
  })

  const italian = await app.inject({ url: '/', headers: { 'accept-language': 'it-IT' } })
  assert.equal(italian.json().message, 'Server non trovato')
  const english = await app.inject({ url: '/' })
  assert.equal(english.json().message, 'Server not found')
  await app.close()
})

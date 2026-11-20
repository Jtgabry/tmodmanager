import { AsyncLocalStorage } from 'node:async_hooks'
import it from './i18n/it.js'

/**
 * Lingua dei messaggi dell'agent (errori, avanzamento dei lavori) che arrivano al pannello.
 * Il testo inglese nel codice è la chiave; l'italiano sta in i18n/it.ts. La lingua è quella della richiesta
 * (Accept-Language, che Laravel gira dalla SPA) e vale anche per il lavoro che la richiesta avvia in
 * background; senza richiesta (timer, avvio) è l'inglese.
 */
export type Locale = 'en' | 'it'
export type MessageKey = keyof typeof it

const storage = new AsyncLocalStorage<Locale>()

export function localeFrom(header: string | string[] | undefined): Locale {
  const value = (Array.isArray(header) ? header[0] : header) ?? ''
  const first = value.split(',')[0]?.trim().toLowerCase() ?? ''
  return first === 'it' || first.startsWith('it-') ? 'it' : 'en'
}

/** Esegue `fn` (e ciò che avvia) con la lingua indicata. */
export const withLocale = <T>(locale: Locale, fn: () => T): T => storage.run(locale, fn)

export const currentLocale = (): Locale => storage.getStore() ?? 'en'

/** Traduce un testo; i segnaposto `{nome}` si sostituiscono con `params`. */
export function tr(key: MessageKey, params?: Record<string, string | number>): string {
  const text = currentLocale() === 'it' ? ((it as Record<string, string>)[key] ?? key) : key
  return params ? text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match)) : text
}

/** Testo che arriva da fuori (es. i motivi della mod LiveMap): tradotto se è nel dizionario, altrimenti com'è. */
export const trText = (text: string): string => tr(text as MessageKey)

import { Fragment, createElement, type ReactNode } from 'react'
import it from './it'

/**
 * Traduzioni del pannello. Il testo inglese nel codice è la chiave (stile gettext):
 * in inglese si mostra così com'è, nelle altre lingue si cerca nel dizionario (it/).
 * Una chiave che manca nel dizionario è un errore di compilazione. Se lo stesso testo inglese va tradotto in
 * modi diversi si aggiunge un contesto dopo «|» ('Enabled|mods'), che non viene mai mostrato.
 */
export type Locale = 'en' | 'it'
export type MessageKey = keyof typeof it
type Params = Record<string, string | number>

export const LOCALES: { code: Locale; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'it', label: 'Italiano' },
]
export const DEFAULT_LOCALE: Locale = 'en'
const STORAGE_KEY = 'tmm.locale'

const dictionaries: Record<Exclude<Locale, 'en'>, Record<MessageKey, string>> = { it }

function storedLocale(): Locale {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (LOCALES.some((l) => l.code === value)) return value as Locale
  } catch {
    // storage non disponibile (navigazione privata, …): lingua predefinita
  }
  return DEFAULT_LOCALE
}

let current: Locale = storedLocale()
document.documentElement.lang = current

export const getLocale = (): Locale => current

/** Cambia la lingua (la ricorda nel browser). L'interfaccia la applica rimontandosi: vedi LocaleProvider. */
export function setCurrentLocale(next: Locale) {
  current = next
  document.documentElement.lang = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // la scelta vale solo per questa sessione
  }
}

/** Locale per Intl (date e numeri). */
export const intlLocale = (): string => (current === 'it' ? 'it-IT' : 'en-GB')

/** «Testo|contesto»: lo stesso testo inglese con traduzioni diverse; il contesto non si mostra mai. */
const bare = (key: string) => {
  const bar = key.indexOf('|')
  return bar === -1 ? key : key.slice(0, bar)
}

function lookup(key: MessageKey): string {
  return current === 'en' ? bare(key) : (dictionaries[current][key] ?? bare(key))
}

/** Traduce un testo; i segnaposto `{nome}` si sostituiscono con `params`. */
export function t(key: MessageKey, params?: Params): string {
  const text = lookup(key)
  return params ? text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match)) : text
}

/** Come `t`, ma i segnaposto possono essere elementi React (link, grassetti, …). */
export function tn(key: MessageKey, params: Record<string, ReactNode>): ReactNode {
  return lookup(key)
    .split(/(\{\w+\})/)
    .map((part, i) => {
      const name = part.match(/^\{(\w+)\}$/)?.[1]
      return createElement(Fragment, { key: i }, name !== undefined && name in params ? params[name] : part)
    })
}


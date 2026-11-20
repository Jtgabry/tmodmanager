import { useQueryClient } from '@tanstack/react-query'
import { Fragment, createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { getLocale, LOCALES, setCurrentLocale, t, type Locale } from '.'

type LocaleContextValue = { locale: Locale; setLocale: (locale: Locale) => void }
const LocaleContext = createContext<LocaleContextValue | null>(null)

/**
 * Cambiando lingua l'interfaccia si rimonta (key): `t` è una funzione semplice, usabile anche fuori
 * dai componenti, e così ogni testo viene ricalcolato senza dover sottoscrivere un contesto.
 * I dati già caricati si richiedono di nuovo, per avere anche i messaggi del server nella lingua scelta.
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [locale, setState] = useState<Locale>(getLocale)
  const setLocale = useCallback(
    (next: Locale) => {
      setCurrentLocale(next)
      setState(next)
      void queryClient.invalidateQueries()
    },
    [queryClient],
  )
  return (
    <LocaleContext.Provider value={{ locale, setLocale }}>
      <Fragment key={locale}>{children}</Fragment>
    </LocaleContext.Provider>
  )
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext)
  if (!ctx) throw new Error('useLocale must be used inside <LocaleProvider>')
  return ctx
}

/** Selettore della lingua (barra in alto, pagine di accesso). */
export function LanguageSelect({ className }: { className?: string }) {
  const { locale, setLocale } = useLocale()
  return (
    <select
      className={className ? `lang-select ${className}` : 'lang-select'}
      aria-label={t('Language')}
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
    >
      {LOCALES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.label}
        </option>
      ))}
    </select>
  )
}

import axios, { AxiosError } from 'axios'

// Stesso dominio del backend: Sanctum usa i cookie di sessione (auth SPA).
export const api = axios.create({
  baseURL: '/api/v1',
  withCredentials: true,
  withXSRFToken: true,
  headers: { Accept: 'application/json' },
})

/** Ottiene il cookie XSRF-TOKEN: va chiamato prima di login e registrazione. */
export const ensureCsrfCookie = () => axios.get('/sanctum/csrf-cookie', { withCredentials: true })

// Token CSRF scaduto (419): rinnova il cookie e ripete la richiesta una volta sola.
api.interceptors.response.use(undefined, async (error: AxiosError) => {
  const config = error.config as (typeof error.config & { _csrfRetried?: boolean }) | undefined
  if (error.response?.status === 419 && config && !config._csrfRetried) {
    config._csrfRetried = true
    await ensureCsrfCookie()
    return api.request(config)
  }
  throw error
})

type ErrorBody = { message?: string; errors?: Record<string, string[]> }

/** Messaggio leggibile da un errore delle API (validazione, agent, rete). */
export function errorMessage(error: unknown): string {
  if (error instanceof AxiosError) {
    const body = error.response?.data as ErrorBody | undefined
    const firstFieldError = body?.errors ? Object.values(body.errors)[0]?.[0] : undefined
    if (firstFieldError) return firstFieldError
    if (body?.message) return body.message
    if (!error.response) return 'Impossibile contattare il server.'
    return `Errore ${error.response.status}`
  }
  return error instanceof Error ? error.message : 'Errore sconosciuto'
}

export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof AxiosError)) return {}
  const errors = (error.response?.data as ErrorBody | undefined)?.errors ?? {}
  return Object.fromEntries(Object.entries(errors).map(([field, messages]) => [field, messages[0]]))
}

export const statusOf = (error: unknown) => (error instanceof AxiosError ? error.response?.status : undefined)

import { useQuery } from '@tanstack/react-query'
import { api } from './api'

/** Primo avvio: true finché non esiste un amministratore (il sito mostra la pagina di configurazione). */
export function useSetupRequired() {
  return useQuery({
    queryKey: ['setup'],
    queryFn: async () => (await api.get<{ data: { required: boolean } }>('/setup')).data.data.required,
    staleTime: 60_000,
    retry: false,
  })
}

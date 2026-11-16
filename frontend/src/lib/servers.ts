import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import type { PowerAction, Server } from './types'

/** Polling più fitto mentre un'operazione è in corso, per vedere gli stati cambiare. */
const pollInterval = (servers: Server[] | undefined) =>
  servers?.some((s) => s.operation || s.state === 'starting' || s.state === 'stopping') ? 1500 : 5000

export function useServers() {
  return useQuery({
    queryKey: ['servers'],
    queryFn: async () => (await api.get<{ data: Server[] }>('/servers')).data.data,
    refetchInterval: (query) => pollInterval(query.state.data),
  })
}

export function useServer(id: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    enabled,
    queryKey: ['servers', id],
    queryFn: async () => (await api.get<{ data: Server }>(`/servers/${id}`)).data.data,
    refetchInterval: (query) => pollInterval(query.state.data ? [query.state.data] : undefined),
  })
}

export function usePowerAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, action }: { id: string; action: PowerAction }) =>
      (await api.post<{ data: Server }>(`/servers/${id}/${action}`)).data.data,
    onSuccess: (server) => {
      queryClient.setQueryData(['servers', server.id], server)
      queryClient.invalidateQueries({ queryKey: ['servers'] })
    },
  })
}

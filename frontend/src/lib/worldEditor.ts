import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from './api'
import type { WorldEditOp, WorldEditorCatalog, WorldEditResult } from './types'

/** Operazioni per richiesta (come l'agent e la mod): i tratti più lunghi si mandano a pezzi. */
const MAX_OPS = 4096

/** Blocchi e muri che l'editor può piazzare: cambiano solo a ogni avvio del server. */
export function useWorldEditorCatalog(serverId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['servers', serverId, 'map', 'editor', 'catalog'],
    queryFn: async () => (await api.get<{ data: WorldEditorCatalog }>(`/servers/${serverId}/map/editor/catalog`)).data.data,
    enabled,
    staleTime: 60_000,
    retry: false,
  })
}

/** Applica modifiche al mondo a server acceso; l'esito somma quello dei pezzi. */
export function useWorldEdit(serverId: string) {
  return useMutation({
    mutationFn: async (ops: WorldEditOp[]): Promise<WorldEditResult> => {
      const total: WorldEditResult = { applied: 0, failed: 0, failures: [] }
      for (let i = 0; i < ops.length; i += MAX_OPS) {
        const { data } = await api.post<{ data: WorldEditResult }>(`/servers/${serverId}/map/editor`, { ops: ops.slice(i, i + MAX_OPS) })
        total.applied += data.data.applied
        total.failed += data.data.failed
        total.failures.push(...data.data.failures)
      }
      return total
    },
  })
}

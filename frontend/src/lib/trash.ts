import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import type { TrashItem } from './types'

const key = (serverId: string) => ['servers', serverId, 'trash']

export function useTrash(serverId: string) {
  return useQuery({
    queryKey: key(serverId),
    queryFn: async () => (await api.get<{ data: TrashItem[] }>(`/servers/${serverId}/trash`)).data.data,
  })
}

/** Dopo un ripristino cambiano anche file, mod e stato del server. */
function useRefresh(serverId: string) {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: ['servers', serverId] })
}

export function useTrashActions(serverId: string) {
  const refresh = useRefresh(serverId)
  const base = `/servers/${serverId}/trash`
  const restore = useMutation({
    mutationFn: async (v: { id: string; overwrite?: boolean }) =>
      (await api.post<{ data: { replaced?: boolean; replacedVersion?: string | null } }>(`${base}/${v.id}/restore`, { overwrite: v.overwrite ?? false })).data.data,
    onSettled: refresh,
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`${base}/${id}`),
    onSettled: refresh,
  })
  const empty = useMutation({
    mutationFn: async () => (await api.delete<{ data: { removed: number } }>(base)).data.data,
    onSettled: refresh,
  })
  return { restore, remove, empty }
}

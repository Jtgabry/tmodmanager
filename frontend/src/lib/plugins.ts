import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import type { Plugin, PluginList, PluginUploadResult, PluginVersion } from './types'

const pluginsKey = (serverId: string) => ['servers', serverId, 'plugins']

export const pluginDownloadUrl = (serverId: string, name: string, versionId: string) =>
  `/api/v1/servers/${serverId}/plugins/${encodeURIComponent(name)}/versions/${versionId}/download`

export const pluginTitle = (plugin: Pick<Plugin, 'name' | 'title'>) => plugin.title ?? plugin.name

/** Etichetta di una versione: numero dichiarato dal file, altrimenti l'inizio dell'impronta. */
export const versionLabel = (version: Pick<PluginVersion, 'id' | 'version'>) => (version.version ? `v${version.version}` : version.id.slice(0, 8))

export function usePlugins(serverId: string) {
  return useQuery({
    queryKey: pluginsKey(serverId),
    queryFn: async () => (await api.get<{ data: PluginList }>(`/servers/${serverId}/plugins`)).data.data,
  })
}

/** Dopo ogni modifica: elenco dei plugin, cestino e stato del server (avviso "riavvio necessario"). */
function useRefresh(serverId: string) {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: pluginsKey(serverId) }),
      queryClient.invalidateQueries({ queryKey: ['servers', serverId, 'trash'] }),
      queryClient.invalidateQueries({ queryKey: ['servers', serverId], exact: true }),
    ])
}

export function useUploadPlugin(serverId: string) {
  const refresh = useRefresh(serverId)
  return useMutation({
    mutationFn: async (vars: { file: File; enable: boolean; onProgress?: (fraction: number) => void }) => {
      const form = new FormData()
      form.append('file', vars.file)
      form.append('enable', vars.enable ? '1' : '0')
      const { data } = await api.post<{ data: PluginUploadResult }>(`/servers/${serverId}/plugins`, form, {
        timeout: 0,
        onUploadProgress: (e) => e.total && vars.onProgress?.(e.loaded / e.total),
      })
      return data.data
    },
    onSettled: refresh,
  })
}

export function useTogglePlugin(serverId: string) {
  const refresh = useRefresh(serverId)
  return useMutation({
    mutationFn: async ({ name, enabled }: { name: string; enabled: boolean }) =>
      (await api.patch<{ data: Plugin }>(`/servers/${serverId}/plugins/${encodeURIComponent(name)}`, { enabled })).data.data,
    onSettled: refresh,
  })
}

export function useDeletePlugin(serverId: string) {
  const refresh = useRefresh(serverId)
  return useMutation({
    mutationFn: (name: string) => api.delete(`/servers/${serverId}/plugins/${encodeURIComponent(name)}`),
    onSettled: refresh,
  })
}

export function useUsePluginVersion(serverId: string) {
  const refresh = useRefresh(serverId)
  return useMutation({
    mutationFn: async ({ name, id }: { name: string; id: string }) =>
      (await api.post<{ data: Plugin }>(`/servers/${serverId}/plugins/${encodeURIComponent(name)}/versions/${id}/use`)).data.data,
    onSettled: refresh,
  })
}

export function useDeletePluginVersion(serverId: string) {
  const refresh = useRefresh(serverId)
  return useMutation({
    mutationFn: async ({ name, id }: { name: string; id: string }) =>
      (await api.delete<{ data: Plugin }>(`/servers/${serverId}/plugins/${encodeURIComponent(name)}/versions/${id}`)).data.data,
    onSettled: refresh,
  })
}

/** Tutte le versioni tranne quella scelta. */
export function usePruneVersions(serverId: string) {
  const refresh = useRefresh(serverId)
  return useMutation({
    mutationFn: async (name: string) =>
      (await api.delete<{ data: { plugin: Plugin; removed: number } }>(`/servers/${serverId}/plugins/${encodeURIComponent(name)}/versions`)).data.data,
    onSettled: refresh,
  })
}

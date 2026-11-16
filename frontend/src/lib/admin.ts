import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import type { Installation, ServerSettings, TmlRelease } from './types'

export type NewServer = {
  id: string
  name: string
  installDir: string
  port: number
  maxPlayers: number
  password: string
  motd: string
  world: { name: string; size: 1 | 2 | 3; difficulty: 0 | 1 | 2 | 3; seed: string }
  copyModsFrom: string | null
}

export type ServerSettingsInput = Partial<Pick<ServerSettings, 'name' | 'port' | 'maxPlayers' | 'motd'>> & { password?: string }

const busy = (list: Installation[] | undefined) => list?.some((i) => i.job && !['done', 'error'].includes(i.job.phase))

export function useInstallations() {
  return useQuery({
    queryKey: ['admin', 'installations'],
    queryFn: async () => (await api.get<{ data: Installation[] }>('/admin/installations')).data.data,
    // Durante un aggiornamento si segue l'avanzamento
    refetchInterval: (query) => (busy(query.state.data) ? 1500 : false),
  })
}

export function useReleases() {
  return useQuery({
    queryKey: ['admin', 'tml-releases'],
    queryFn: async () => (await api.get<{ data: TmlRelease[] }>('/admin/tmodloader/releases')).data.data,
    staleTime: 5 * 60 * 1000,
  })
}

export function useServerDefaults(enabled: boolean) {
  return useQuery({
    queryKey: ['admin', 'server-defaults'],
    queryFn: async () => (await api.get<{ data: { port: number; installDirs: string[]; ports: { min: number; max: number } | null } }>('/admin/servers/defaults')).data.data,
    enabled,
  })
}

export function useServerSettings(id: string | null) {
  return useQuery({
    queryKey: ['admin', 'servers', id],
    queryFn: async () => (await api.get<{ data: ServerSettings }>(`/admin/servers/${id}`)).data.data,
    enabled: id !== null,
  })
}

export function useAdminServerActions() {
  const queryClient = useQueryClient()
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['servers'] }),
      queryClient.invalidateQueries({ queryKey: ['admin'] }),
    ])

  const create = useMutation({
    mutationFn: async (input: NewServer) => (await api.post<{ data: { id: string; saveDir: string } }>('/admin/servers', input, { timeout: 0 })).data.data,
    onSuccess: refresh,
  })
  const update = useMutation({
    mutationFn: async ({ id, ...input }: ServerSettingsInput & { id: string }) =>
      (await api.patch<{ data: ServerSettings }>(`/admin/servers/${id}`, input)).data.data,
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete<{ data: { saveDir: string } }>(`/admin/servers/${id}`)).data.data,
    onSuccess: refresh,
  })
  const updateTml = useMutation({
    mutationFn: async ({ id, ...body }: { id: string; restartServers: boolean } & ({ version: string } | { backup: string })) =>
      (await api.post(`/admin/installations/${id}/update`, body)).data,
    onSettled: refresh,
  })
  return { create, update, remove, updateTml }
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'

export type WorldBackup = {
  name: string
  createdAt: string
  size: number
  world: string
  /** Fatto dal backup automatico giornaliero (si tengono solo gli ultimi `schedule.keep`). */
  auto: boolean
  files: string[]
}

export type BackupSchedule = {
  /** "04:00", null se disattivato. */
  time: string | null
  timeZone: string
  keep: number
  next: string | null
}

export type RestoreResult = { world: string; restored: string[]; trashed: string[] }

export type BackupResult = { backup: WorldBackup; saved: boolean; running: boolean }

const key = (serverId: string) => ['servers', serverId, 'backups']

export const backupDownloadUrl = (serverId: string, name: string) => `/api/v1/servers/${serverId}/backups/${name}/download`

export function useBackups(serverId: string) {
  return useQuery({
    queryKey: key(serverId),
    queryFn: async () =>
      (await api.get<{ data: { backups: WorldBackup[]; schedule: BackupSchedule } }>(`/servers/${serverId}/backups`)).data.data,
  })
}

export function useBackupActions(serverId: string) {
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: key(serverId) })
  const create = useMutation({
    // Con il server acceso si aspetta che salvi il mondo (fino a un minuto)
    mutationFn: async () => (await api.post<{ data: BackupResult }>(`/servers/${serverId}/backups`, null, { timeout: 0 })).data.data,
    onSettled: refresh,
  })
  const remove = useMutation({
    mutationFn: (name: string) => api.delete(`/servers/${serverId}/backups/${name}`),
    onSettled: refresh,
  })
  const restore = useMutation({
    mutationFn: async (name: string) =>
      (await api.post<{ data: RestoreResult }>(`/servers/${serverId}/backups/${name}/restore`, null, { timeout: 0 })).data.data,
    // Cambiano anche mondo, cestino e stato del server
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['servers', serverId] }),
  })
  return { create, remove, restore }
}

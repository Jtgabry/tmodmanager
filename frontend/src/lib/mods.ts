import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AxiosError } from 'axios'
import { api } from './api'
import type { ArchiveEntry, ArchivedVersion, ImportablePack, ModList, Modpack, ModpackActivationResult, ModpackImportResult, UploadResult } from './types'

const modsKey = (serverId: string) => ['servers', serverId, 'mods']
const packsKey = (serverId: string) => ['servers', serverId, 'modpacks']
const archiveKey = (serverId: string) => ['servers', serverId, 'archive']

export const modDownloadUrl = (serverId: string, name: string) => `/api/v1/servers/${serverId}/mods/${name}/download`

export function useMods(serverId: string) {
  return useQuery({
    queryKey: modsKey(serverId),
    queryFn: async () => (await api.get<{ data: ModList }>(`/servers/${serverId}/mods`)).data.data,
  })
}

export function useModpacks(serverId: string) {
  return useQuery({
    queryKey: packsKey(serverId),
    queryFn: async () => (await api.get<{ data: Modpack[] }>(`/servers/${serverId}/modpacks`)).data.data,
  })
}

/** Dopo ogni modifica: ricarica mod, pack e stato del server (per l'avviso "riavvio necessario"). */
function useRefresh(serverId: string) {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: modsKey(serverId) }),
      queryClient.invalidateQueries({ queryKey: packsKey(serverId) }),
      queryClient.invalidateQueries({ queryKey: archiveKey(serverId) }),
      queryClient.invalidateQueries({ queryKey: ['servers', serverId], exact: true }),
    ])
}

/** Dettagli di un 409/422 dell'agent (mod dipendenti o mancanti). */
export function conflictDetails(error: unknown): { dependents?: string[]; missing?: string[] } | null {
  if (!(error instanceof AxiosError) || ![409, 422].includes(error.response?.status ?? 0)) return null
  return (error.response?.data as { details?: { dependents?: string[]; missing?: string[] } })?.details ?? null
}

export function useToggleMod(serverId: string) {
  const refresh = useRefresh(serverId)
  return useMutation({
    mutationFn: async (vars: { name: string; enabled: boolean; cascade?: boolean }) =>
      (
        await api.patch<{ data: { enabled: string[]; disabled: string[] } }>(`/servers/${serverId}/mods/${vars.name}`, {
          enabled: vars.enabled,
          cascade: vars.cascade ?? false,
        })
      ).data.data,
    onSettled: refresh,
  })
}

export function useDeleteMod(serverId: string) {
  const refresh = useRefresh(serverId)
  return useMutation({
    mutationFn: async (vars: { name: string; cascade?: boolean }) =>
      (
        await api.delete<{ data: { disabled: string[] } }>(`/servers/${serverId}/mods/${vars.name}`, {
          params: { cascade: vars.cascade ? 1 : 0 },
        })
      ).data.data,
    onSettled: refresh,
  })
}

export function useUploadMod(serverId: string) {
  const refresh = useRefresh(serverId)
  return useMutation({
    mutationFn: async (vars: { file: File; enable: boolean; onProgress?: (fraction: number) => void }) => {
      const form = new FormData()
      form.append('file', vars.file)
      form.append('enable', vars.enable ? '1' : '0')
      const { data } = await api.post<{ data: UploadResult }>(`/servers/${serverId}/mods`, form, {
        timeout: 0,
        onUploadProgress: (e) => e.total && vars.onProgress?.(e.loaded / e.total),
      })
      return data.data
    },
    onSettled: refresh,
  })
}

export type ModpackInput = { name: string; description: string; mods: string[]; versions: Record<string, string> }

export function useSaveModpack(serverId: string) {
  const refresh = useRefresh(serverId)
  return useMutation({
    mutationFn: async ({ id, ...input }: ModpackInput & { id?: string }) =>
      id
        ? (await api.put<{ data: Modpack }>(`/servers/${serverId}/modpacks/${id}`, input)).data.data
        : (await api.post<{ data: Modpack }>(`/servers/${serverId}/modpacks`, input)).data.data,
    onSettled: refresh,
  })
}

export function useDeleteModpack(serverId: string) {
  const refresh = useRefresh(serverId)
  return useMutation({
    mutationFn: (id: string) => api.delete(`/servers/${serverId}/modpacks/${id}`),
    onSettled: refresh,
  })
}

export function useModpackActivation(serverId: string) {
  const refresh = useRefresh(serverId)
  return useMutation({
    mutationFn: async ({ id, active, exclusive = false }: { id: string; active: boolean; exclusive?: boolean }) =>
      (
        await (active
          ? api.post<{ data: ModpackActivationResult }>(`/servers/${serverId}/modpacks/${id}/activation`, exclusive ? { exclusive: true } : undefined, {
              timeout: 120_000,
            })
          : api.delete<{ data: ModpackActivationResult }>(`/servers/${serverId}/modpacks/${id}/activation`))
      ).data.data,
    onSettled: refresh,
  })
}

/** Modpack di tModLoader nella cartella Mods/ModPacks del server. */
export function useImportablePacks(serverId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...packsKey(serverId), 'importable'],
    queryFn: async () => (await api.get<{ data: ImportablePack[] }>(`/servers/${serverId}/modpacks/importable`)).data.data,
    enabled,
  })
}

/** Importa un pack di tModLoader: dalla cartella del server (name) o caricando .json/.zip (file). */
export function useImportModpack(serverId: string) {
  const refresh = useRefresh(serverId)
  return useMutation({
    mutationFn: async (vars: { name?: string; file?: File; replaceExisting: boolean; onProgress?: (fraction: number) => void }) => {
      if (vars.file) {
        const form = new FormData()
        form.append('file', vars.file)
        form.append('replaceExisting', vars.replaceExisting ? '1' : '0')
        const { data } = await api.post<{ data: ModpackImportResult }>(`/servers/${serverId}/modpacks/import`, form, {
          timeout: 0,
          onUploadProgress: (e) => e.total && vars.onProgress?.(e.loaded / e.total),
        })
        return data.data
      }
      const { data } = await api.post<{ data: ModpackImportResult }>(
        `/servers/${serverId}/modpacks/import`,
        { name: vars.name, replaceExisting: vars.replaceExisting },
        { timeout: 0 },
      )
      return data.data
    },
    onSettled: refresh,
  })
}

export const modIconUrl = (serverId: string, mod: { name: string; modifiedAt: string }) =>
  // La data del file nell'indirizzo: quando la mod cambia, il browser riscarica l'icona
  `/api/v1/servers/${serverId}/mods/${mod.name}/icon?v=${encodeURIComponent(mod.modifiedAt)}`

/** Tag del Workshop che non sono categorie: lato, versioni di tModLoader e lingue (mostrati altrove o inutili qui). */
const NON_CATEGORY_TAGS = new Set([
  'Client', 'Server', 'Both', 'NoSync',
  'English', 'German', 'Italian', 'French', 'Spanish', 'Russian', 'Simplified Chinese', 'Brazilian Portuguese', 'Polish',
])

/** Solo le categorie tra i tag del Workshop ("Quality Of Life", "Library"…). */
export const workshopCategories = (tags: string[] | undefined) =>
  (tags ?? []).filter((tag) => !NON_CATEGORY_TAGS.has(tag) && !/^\d+(\.\d+)+$/.test(tag))

/** Immagine di una mod: la sua icona, altrimenti l'anteprima della pagina del Workshop (null se nessuna). */
export const modImageUrl = (serverId: string, mod: { name: string; modifiedAt: string; hasIcon?: boolean; workshop?: { previewUrl: string | null } | null }) =>
  mod.hasIcon ? modIconUrl(serverId, mod) : (mod.workshop?.previewUrl ?? null)

// --- Archivio delle versioni ------------------------------------------------------------------

export function useArchive(serverId: string) {
  return useQuery({
    queryKey: archiveKey(serverId),
    queryFn: async () => (await api.get<{ data: ArchiveEntry[] }>(`/servers/${serverId}/archive`)).data.data,
  })
}

/** Aggiunge a mano un .tmod all'archivio. */
export function useUploadToArchive(serverId: string) {
  const refresh = useRefresh(serverId)
  return useMutation({
    mutationFn: async (vars: { file: File; onProgress?: (fraction: number) => void }) => {
      const form = new FormData()
      form.append('file', vars.file)
      const { data } = await api.post<{ data: ArchivedVersion & { name: string } }>(`/servers/${serverId}/archive`, form, {
        timeout: 0,
        onUploadProgress: (e) => e.total && vars.onProgress?.(e.loaded / e.total),
      })
      return data.data
    },
    onSettled: refresh,
  })
}

export function useDeleteArchived(serverId: string) {
  const refresh = useRefresh(serverId)
  return useMutation({
    mutationFn: ({ name, version }: { name: string; version: string }) => api.delete(`/servers/${serverId}/archive/${name}/${version}`),
    onSettled: refresh,
  })
}

/** Installa una versione archiviata al posto di quella attuale. */
export function useUseArchived(serverId: string) {
  const refresh = useRefresh(serverId)
  return useMutation({
    mutationFn: ({ name, version }: { name: string; version: string }) =>
      api.post<{ data: UploadResult }>(`/servers/${serverId}/archive/${name}/${version}/use`, undefined, { timeout: 60_000 }),
    onSettled: refresh,
  })
}

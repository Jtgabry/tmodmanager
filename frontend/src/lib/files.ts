import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'

/** limited = cartella di tModLoader: solo i .txt di primo livello e i log. */
export type FileRoot = { id: string; label: string; path: string; limited: boolean }
export type FileEntry = { name: string; type: 'file' | 'dir' | 'link' | 'other'; size: number; modifiedAt: string }
export type Listing = { root: string; path: string; limited: boolean; entries: FileEntry[] }

/** Estensioni aperte nell'editor di testo. */
const TEXT_EXTENSIONS = ['txt', 'json', 'cfg', 'ini', 'log', 'md', 'toml', 'yml', 'yaml', 'xml', 'csv', 'properties', 'conf', 'sh', 'bat', 'hjson', 'nbt.json']
export const isTextFile = (name: string) => {
  const lower = name.toLowerCase()
  return TEXT_EXTENSIONS.some((ext) => lower.endsWith(`.${ext}`)) || !lower.includes('.')
}

export const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)

export const downloadUrl = (serverId: string, root: string, path: string) =>
  `/api/v1/servers/${serverId}/files/download?${new URLSearchParams({ root, path })}`

export function useFileRoots(serverId: string) {
  return useQuery({
    queryKey: ['servers', serverId, 'files', 'roots'],
    queryFn: async () => (await api.get<{ data: FileRoot[] }>(`/servers/${serverId}/files/roots`)).data.data,
  })
}

export function useListing(serverId: string, root: string | undefined, path: string) {
  return useQuery({
    queryKey: ['servers', serverId, 'files', root, path],
    queryFn: async () => (await api.get<{ data: Listing }>(`/servers/${serverId}/files`, { params: { root, path } })).data.data,
    enabled: Boolean(root),
  })
}

function useRefresh(serverId: string) {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: ['servers', serverId, 'files'] })
}

export function useFileActions(serverId: string) {
  const refresh = useRefresh(serverId)
  const base = `/servers/${serverId}/files`

  const mkdir = useMutation({
    mutationFn: (v: { root: string; path: string; name: string }) => api.post(`${base}/directories`, v),
    onSettled: refresh,
  })
  const rename = useMutation({
    mutationFn: (v: { root: string; path: string; name: string }) => api.post(`${base}/rename`, v),
    onSettled: refresh,
  })
  const remove = useMutation({
    mutationFn: (v: { root: string; path: string }) => api.delete(base, { params: v }),
    onSettled: refresh,
  })
  const upload = useMutation({
    mutationFn: async (v: { root: string; path: string; file: File; overwrite: boolean; onProgress?: (p: number) => void }) => {
      const form = new FormData()
      form.append('file', v.file)
      form.append('root', v.root)
      form.append('path', v.path)
      form.append('overwrite', v.overwrite ? '1' : '0')
      return (
        await api.post<{ data: { name: string; size: number; replaced: boolean } }>(`${base}/upload`, form, {
          timeout: 0,
          onUploadProgress: (e) => e.total && v.onProgress?.(e.loaded / e.total),
        })
      ).data.data
    },
    onSettled: refresh,
  })

  return { mkdir, rename, remove, upload }
}

export async function readTextFile(serverId: string, root: string, path: string) {
  return (await api.get<{ data: { content: string; modifiedAt: string } }>(`/servers/${serverId}/files/content`, { params: { root, path } })).data.data
}

export async function saveTextFile(serverId: string, root: string, path: string, content: string, expectedModifiedAt: string | null) {
  return (
    await api.put<{ data: { modifiedAt: string } }>(`/servers/${serverId}/files/content`, { root, path, content, expectedModifiedAt })
  ).data.data
}

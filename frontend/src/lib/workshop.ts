import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { api } from './api'
import type {
  ApplyPendingResult,
  BrowseDetails,
  BrowsePage,
  BrowseSort,
  ModUpdate,
  PendingMod,
  UpdateJob,
  UpdateReport,
  WorkshopSearchResult,
} from './types'

/** Aggiornamento disponibile (o probabile, senza chiave Steam). */
export const isUpdatable = (u: ModUpdate | undefined) => u?.status === 'update' || u?.status === 'maybe'

const updatesKey = (serverId: string) => ['servers', serverId, 'mods', 'updates']
const jobKey = (serverId: string) => ['servers', serverId, 'mods', 'updates', 'job']
const pendingKey = (serverId: string) => ['servers', serverId, 'workshop', 'pending']

/** Stato degli aggiornamenti dal Workshop (l'agent tiene in cache le risposte di Steam per 10 minuti). */
export function useModUpdates(serverId: string) {
  return useQuery({
    queryKey: updatesKey(serverId),
    queryFn: async () => (await api.get<{ data: UpdateReport }>(`/servers/${serverId}/mods/updates`, { timeout: 120_000 })).data.data,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

/** "Ricontrolla": chiede a Steam ignorando la cache e ricerca le mod non trovate. */
export function useRecheckUpdates(serverId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () =>
      (await api.get<{ data: UpdateReport }>(`/servers/${serverId}/mods/updates`, { params: { refresh: 1 }, timeout: 120_000 })).data.data,
    onSuccess: (report) => queryClient.setQueryData(updatesKey(serverId), report),
  })
}

/**
 * Ultimo lavoro di download (aggiornamenti e installazioni); si aggiorna ogni secondo finché è in corso.
 * Quando finisce si ricaricano mod, aggiornamenti, mod in attesa e server (avviso "riavvio necessario").
 */
export function useUpdateJob(serverId: string) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: jobKey(serverId),
    queryFn: async () => (await api.get<{ data: UpdateJob | null }>(`/servers/${serverId}/mods/updates/job`)).data.data,
    refetchInterval: (q) => (q.state.data?.state === 'running' ? 1000 : false),
  })
  const state = query.data?.state
  const previous = useRef(state)
  useEffect(() => {
    if (previous.current === 'running' && state && state !== 'running') {
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'servers' && q.queryKey[1] === serverId && q.queryKey.at(-1) !== 'job' })
    }
    previous.current = state
  }, [state, queryClient, serverId])
  return query
}

/** Aggiorna le mod indicate (se c'è già un download in corso si mettono in coda). */
export function useStartUpdate(serverId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (mods: string[]) => (await api.post<{ data: UpdateJob }>(`/servers/${serverId}/mods/updates`, { mods })).data.data,
    onSuccess: (job) => queryClient.setQueryData(jobKey(serverId), job),
  })
}

/** Annulla il download (o l'aggiornamento) di una mod del lavoro in corso. */
export function useCancelJobItem(serverId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (name: string) => (await api.delete<{ data: UpdateJob }>(`/servers/${serverId}/mods/updates/job/${name}`)).data.data,
    onSuccess: (job) => queryClient.setQueryData(jobKey(serverId), job),
  })
}

/** Collega una mod a una pagina del Workshop (link o ID), la segna come "non nel Workshop" (null) o torna all'automatico (reset). */
export function useWorkshopLink(serverId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (vars: { name: string; workshop: string | null } | { name: string; reset: true }) =>
      'reset' in vars
        ? api.delete(`/servers/${serverId}/mods/${vars.name}/workshop`)
        : api.put(`/servers/${serverId}/mods/${vars.name}/workshop`, { workshop: vars.workshop }),
    // Cambia anche la pagina del Workshop collegata (tag, titolo…) mostrata nella lista delle mod
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: updatesKey(serverId), exact: true }),
        queryClient.invalidateQueries({ queryKey: ['servers', serverId, 'mods'], exact: true }),
      ]),
  })
}

export function useWorkshopSearch(serverId: string, query: string) {
  return useQuery({
    queryKey: ['workshop-search', serverId, query],
    queryFn: async () =>
      (await api.get<{ data: WorkshopSearchResult[] }>(`/servers/${serverId}/workshop/search`, { params: { q: query } })).data.data,
    enabled: query.trim().length >= 2,
    staleTime: 10 * 60 * 1000,
    retry: false,
  })
}

/** Risultati del Workshop, 30 per pagina ("Carica altri" prosegue con il cursore di Steam). */
export function useWorkshopBrowse(serverId: string, filters: { q: string; sort: BrowseSort; tag: string | null }) {
  return useInfiniteQuery({
    queryKey: ['workshop-browse', serverId, filters],
    queryFn: async ({ pageParam }) =>
      (
        await api.get<{ data: BrowsePage }>(`/servers/${serverId}/workshop/browse`, {
          params: { q: filters.q || undefined, sort: filters.sort, tag: filters.tag ?? undefined, cursor: pageParam ?? undefined },
          timeout: 30_000,
        })
      ).data.data,
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

/** Pagina completa di un elemento del Workshop. */
export function useWorkshopItem(serverId: string, id: string | null) {
  return useQuery({
    queryKey: ['workshop-item', serverId, id],
    queryFn: async () => (await api.get<{ data: BrowseDetails }>(`/servers/${serverId}/workshop/items/${id}`, { timeout: 30_000 })).data.data,
    enabled: id !== null,
    staleTime: 10 * 60 * 1000,
    retry: false,
  })
}

/** Installa dal Workshop (senza abilitare); se c'è già un download in corso si mette in coda. */
export function useInstallFromWorkshop(serverId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (ids: string[]) => (await api.post<{ data: UpdateJob }>(`/servers/${serverId}/workshop/install`, { ids })).data.data,
    onSuccess: (job) => queryClient.setQueryData(jobKey(serverId), job),
  })
}

/** Installa dal Workshop le mod indicate per nome interno (es. quelle che mancano a un modpack). */
export function useInstallByName(serverId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (names: string[]) =>
      (await api.post<{ data: UpdateJob }>(`/servers/${serverId}/workshop/install-names`, { names }, { timeout: 60_000 })).data.data,
    onSuccess: (job) => queryClient.setQueryData(jobKey(serverId), job),
  })
}

/** Mod installate dal Workshop che aspettano di essere abilitate. */
export function usePendingMods(serverId: string) {
  return useQuery({
    queryKey: pendingKey(serverId),
    queryFn: async () => (await api.get<{ data: PendingMod[] }>(`/servers/${serverId}/workshop/pending`)).data.data,
  })
}

function useRefreshMods(serverId: string) {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: pendingKey(serverId) }),
      queryClient.invalidateQueries({ queryKey: ['servers', serverId, 'mods'], exact: true }),
      queryClient.invalidateQueries({ queryKey: ['servers', serverId, 'modpacks'] }),
      queryClient.invalidateQueries({ queryKey: ['servers', serverId], exact: true }),
    ])
}

/** Abilita tutte insieme le mod in attesa. */
export function useApplyPending(serverId: string) {
  const refresh = useRefreshMods(serverId)
  return useMutation({
    mutationFn: async () => (await api.post<{ data: ApplyPendingResult }>(`/servers/${serverId}/workshop/pending/apply`)).data.data,
    onSettled: refresh,
  })
}

/** Toglie una mod dall'elenco di quelle in attesa (resta installata, disabilitata). */
export function useDismissPending(serverId: string) {
  const refresh = useRefreshMods(serverId)
  return useMutation({
    mutationFn: (name: string) => api.delete(`/servers/${serverId}/workshop/pending/${name}`),
    onSettled: refresh,
  })
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import type { WorldEditOp, WorldEditorCatalog, WorldEditResult, WorldSettingsChange, WorldSettingsState } from './types'
import { worldMapKey } from './worldMap'

const settingsKey = (serverId: string) => ['servers', serverId, 'map', 'editor', 'world']

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

/** Esito di un tratto: somma dei pezzi, con gli id per annullarli (uno per pezzo che ha cambiato qualcosa). */
export type WorldEditOutcome = WorldEditResult & { undoIds: string[] }

/** Applica modifiche al mondo a server acceso; l'esito somma quello dei pezzi. */
export function useWorldEdit(serverId: string) {
  return useMutation({
    mutationFn: async (ops: WorldEditOp[]): Promise<WorldEditOutcome> => {
      const total: WorldEditOutcome = { applied: 0, failed: 0, failures: [], undoIds: [] }
      for (let i = 0; i < ops.length; i += MAX_OPS) {
        const { data } = await api.post<{ data: WorldEditResult }>(`/servers/${serverId}/map/editor`, { ops: ops.slice(i, i + MAX_OPS) })
        total.applied += data.data.applied
        total.failed += data.data.failed
        total.failures.push(...data.data.failures)
        if (data.data.undoId) total.undoIds.push(data.data.undoId)
      }
      return total
    },
  })
}

/**
 * Annulla un tratto: i suoi pezzi dall'ultimo al primo. La mod rimette il mondo com'era, tranne le tile cambiate nel
 * frattempo (contate tra le non riuscite).
 */
export function useWorldUndo(serverId: string) {
  return useMutation({
    mutationFn: async (undoIds: string[]): Promise<WorldEditResult> => {
      const total: WorldEditResult = { applied: 0, failed: 0, failures: [] }
      for (const id of [...undoIds].reverse()) {
        const { data } = await api.post<{ data: WorldEditResult }>(`/servers/${serverId}/map/editor/undo`, { id })
        total.applied += data.data.applied
        total.failed += data.data.failed
        total.failures.push(...data.data.failures)
      }
      return total
    },
  })
}

/** Settaggi del mondo, riletti ogni 3 secondi (la mod li riscrive ogni 2: l'ora del gioco scorre). */
export function useWorldSettings(serverId: string, enabled: boolean) {
  return useQuery({
    queryKey: settingsKey(serverId),
    queryFn: async () => (await api.get<{ data: WorldSettingsState }>(`/servers/${serverId}/map/editor/world`)).data.data,
    enabled,
    refetchInterval: 3000,
    retry: false,
  })
}

/** Cambia i settaggi indicati; dopo, settaggi e mappa (lo spawn è nel manifest) si rileggono. */
export function useChangeWorldSettings(serverId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (change: WorldSettingsChange) =>
      (await api.post<{ data: WorldEditResult }>(`/servers/${serverId}/map/editor/settings`, change)).data.data,
    // Subito nel pannello quello che la mod ha accettato; la rilettura dopo conferma
    onSuccess: (result, change) =>
      queryClient.setQueryData<WorldSettingsState>(settingsKey(serverId), (old) => {
        if (!old) return old
        const failed = new Set(result.failures.map((f) => f.setting))
        const next = { ...old, bosses: { ...old.bosses } }
        for (const [key, value] of Object.entries(change)) {
          if (failed.has(key)) continue
          if (key === 'spawn') Object.assign(next, { spawnX: change.spawn!.x, spawnY: change.spawn!.y })
          else if (key === 'bosses') {
            for (const [boss, down] of Object.entries(change.bosses!)) if (!failed.has(`bosses.${boss}`)) next.bosses[boss as keyof typeof next.bosses] = down
          } else Object.assign(next, { [key]: value })
        }
        if (change.clock !== undefined && !failed.has('clock')) next.day = change.clock >= 270 && change.clock < 1170
        return next
      }),
    onSettled: () =>
      // La mod riscrive world.json ogni 2 secondi: si rilegge dopo, per vedere il cambiamento
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: settingsKey(serverId) })
        void queryClient.invalidateQueries({ queryKey: worldMapKey(serverId), exact: true })
      }, 2100),
  })
}

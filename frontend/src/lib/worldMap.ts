import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import type { WorldMapState } from './types'

export const worldMapKey = (serverId: string) => ['servers', serverId, 'map']

/**
 * Stato della mappa, riletto ogni 3 secondi mentre la pagina è visibile. `watching` dice a LiveMap che
 * qualcuno la sta guardando: senza, il plugin resta in pausa (react-query smette di interrogare quando la
 * scheda del browser è nascosta, quindi anche il plugin si ferma).
 */
export function useWorldMap(serverId: string) {
  return useQuery({
    queryKey: worldMapKey(serverId),
    queryFn: async () => (await api.get<{ data: WorldMapState }>(`/servers/${serverId}/map`, { params: { watching: 1 } })).data.data,
    refetchInterval: 3000,
  })
}

export const chunkUrl = (serverId: string, cx: number, cy: number, version: number) =>
  `/api/v1/servers/${serverId}/map/chunks/${cx}/${cy}?v=${version}`

export const overviewUrl = (serverId: string, version: number) => `/api/v1/servers/${serverId}/map/overview?v=${version}`

import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import type { MapSource, TileTypes, WorldMapState } from './types'

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

export const chunkUrl = (serverId: string, source: MapSource, cx: number, cy: number, version: number) =>
  `/api/v1/servers/${serverId}/map/${source}/chunks/${cx}/${cy}?v=${version}`

export const overviewUrl = (serverId: string, source: MapSource, version: number) => `/api/v1/servers/${serverId}/map/${source}/overview?v=${version}`

/** Dati grezzi delle tile di un riquadro di LiveMap (gzip), per gli sprite da vicino. */
export const tilesUrl = (serverId: string, cx: number, cy: number, version: number) => `/api/v1/servers/${serverId}/map/livemap/tiles/${cx}/${cy}?v=${version}`

export const spriteUrl = (serverId: string, kind: 'tiles' | 'walls', type: number, version: number) =>
  `/api/v1/servers/${serverId}/map/sprites/${kind}/${type}?v=${version}`

/** Tipi di blocchi e muri di LiveMap (cambiano a ogni avvio del server: `version`). */
export function useTileTypes(serverId: string, version: number | null) {
  return useQuery({
    queryKey: ['servers', serverId, 'map', 'types', version],
    queryFn: async () => (await api.get<{ data: TileTypes }>(`/servers/${serverId}/map/livemap/types`, { params: { v: version } })).data.data,
    enabled: version !== null,
    staleTime: Infinity,
    retry: false,
  })
}

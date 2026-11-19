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

/** Dati grezzi delle tile di un riquadro (gzip), per gli sprite da vicino: da LiveMap o dal file del mondo. */
export const tilesUrl = (serverId: string, source: MapSource, cx: number, cy: number, version: number) =>
  `/api/v1/servers/${serverId}/map/${source}/tiles/${cx}/${cy}?v=${version}`

export const spriteUrl = (serverId: string, source: MapSource, kind: 'tiles' | 'walls' | 'treetops' | 'treebranches', type: number, version: number) =>
  `/api/v1/servers/${serverId}/map/${source}/sprites/${kind}/${type}?v=${version}`

/** Tipi di blocchi e muri della sorgente (cambiano a ogni avvio del server o salvataggio del mondo: `version`). */
export function useTileTypes(serverId: string, source: MapSource, version: number | null) {
  return useQuery({
    queryKey: ['servers', serverId, 'map', 'types', source, version],
    queryFn: async () => (await api.get<{ data: TileTypes }>(`/servers/${serverId}/map/${source}/types`, { params: { v: version } })).data.data,
    enabled: version !== null,
    staleTime: Infinity,
    retry: false,
  })
}

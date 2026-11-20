import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import {
  type Game,
  GAME_LABEL,
  type Installation,
  type InstallationChoice,
  type ServerSettings,
  type SwitchJob,
  type SwitchRequest,
  type TmlRelease,
  type UpdateReportAdmin,
} from './types'
import { t } from '../i18n'

export type NewServer = {
  id: string
  name: string
  /** Un'installazione esistente oppure una versione fissa da installare (version). */
  installDir?: string
  version?: { game: Game; version: string }
  port: number
  maxPlayers: number
  password: string
  motd: string
  world: { name: string; size: 1 | 2 | 3; difficulty: 0 | 1 | 2 | 3; seed: string }
  copyModsFrom: string | null
}

export type CreatedServer = {
  id: string
  saveDir: string
  /** Installazione del gioco avviata con la creazione (null se era già installato). */
  install: AutoInstall | null
}

/** Installazione del gioco avviata da una creazione o da un cambio di versione. */
export type AutoInstall = { game: Game; version: string | null; error: string | null }

export type ServerSettingsInput = Partial<Pick<ServerSettings, 'name' | 'port' | 'maxPlayers' | 'motd' | 'installDir' | 'launchArgs'>> & {
  password?: string
  /** Chiavi di serverconfig.txt: null la toglie (vale il default di Terraria). */
  config?: Record<string, string | null>
}

const busy = (list: Installation[] | undefined) => list?.some((i) => i.job && !['done', 'error'].includes(i.job.phase))

export function useInstallations() {
  return useQuery({
    queryKey: ['admin', 'installations'],
    queryFn: async () => (await api.get<{ data: Installation[] }>('/admin/installations')).data.data,
    // Durante un aggiornamento si segue l'avanzamento
    refetchInterval: (query) => (busy(query.state.data) ? 1500 : false),
  })
}

export function useReleases(game: Game, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'releases', game],
    queryFn: async () => (await api.get<{ data: TmlRelease[] }>(`/admin/releases/${game}`)).data.data,
    staleTime: 5 * 60 * 1000,
    enabled,
  })
}

const switching = (report: UpdateReportAdmin | undefined) => report?.switches.some((s) => s.phase !== 'done' && s.phase !== 'error')

/**
 * Avvisi del controllo giornaliero degli aggiornamenti (solo admin). Si rileggono ogni 10 minuti (sono dati
 * dell'agent, non nuove richieste a GitHub) e ogni 2 secondi durante un passaggio di gioco.
 */
export function useGameUpdates(enabled: boolean) {
  return useQuery({
    queryKey: ['admin', 'updates'],
    queryFn: async () => (await api.get<{ data: UpdateReportAdmin }>('/admin/updates')).data.data,
    enabled,
    refetchInterval: (query) => (switching(query.state.data) ? 2000 : 10 * 60 * 1000),
  })
}

export function useServerDefaults(enabled: boolean) {
  return useQuery({
    queryKey: ['admin', 'server-defaults'],
    queryFn: async () => (await api.get<{ data: { port: number; installations: InstallationChoice[]; ports: { min: number; max: number } | null } }>('/admin/servers/defaults')).data.data,
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
    mutationFn: async (input: NewServer) => (await api.post<{ data: CreatedServer }>('/admin/servers', input, { timeout: 0 })).data.data,
    onSuccess: refresh,
  })
  const update = useMutation({
    mutationFn: async ({ id, ...input }: ServerSettingsInput & { id: string }) =>
      (await api.patch<{ data: ServerSettings & { install?: AutoInstall | null } }>(`/admin/servers/${id}`, input)).data.data,
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete<{ data: { saveDir: string } }>(`/admin/servers/${id}`)).data.data,
    onSuccess: refresh,
  })
  const recreateWorld = useMutation({
    mutationFn: async (id: string) => (await api.post<{ data: { trashed: string[] } }>(`/admin/servers/${id}/world/recreate`)).data.data,
    onSuccess: refresh,
  })
  const updateTml = useMutation({
    mutationFn: async ({ id, ...body }: { id: string; restartServers: boolean } & ({ version: string } | { backup: string })) =>
      (await api.post(`/admin/installations/${id}/update`, body)).data,
    onSettled: refresh,
  })
  const addVersion = useMutation({
    mutationFn: async ({ game, version }: { game: Game; version: string }) => (await api.post(`/admin/installations/${game}/versions`, { version })).data,
    onSettled: refresh,
  })
  const removeInstallation = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/admin/installations/${id}`)).data,
    onSettled: refresh,
  })
  /** Passaggio guidato a un'altra installazione, versione o gioco (installa se serve, spegne, cambia, riaccende). */
  const switchGame = useMutation({
    mutationFn: async ({ id, ...target }: { id: string } & SwitchRequest) =>
      (await api.post<{ data: SwitchJob }>(`/admin/servers/${id}/switch-game`, target)).data.data,
    onSettled: refresh,
  })
  const stayVanilla = useMutation({
    mutationFn: async (id: string) => (await api.post(`/admin/servers/${id}/stay-vanilla`)).data,
    onSettled: refresh,
  })
  return { create, update, remove, recreateWorld, updateTml, addVersion, removeInstallation, switchGame, stayVanilla }
}

/** Versione del mondo (primi byte del .wld) → versione di Terraria che lo ha salvato (tabella di TEdit). */
const WORLD_VERSIONS: [number, string][] = [
  [279, '1.4.4.9'],
  [315, '1.4.5.0–1.4.5.2'],
  [316, '1.4.5.3'],
  [317, '1.4.5.4'],
  [318, '1.4.5.5'],
  [319, '1.4.5.6'],
  [325, '1.4.5.7'],
  [326, '1.4.5.8'],
]

export function worldVersionLabel(release: number): string {
  const known = WORLD_VERSIONS.find(([r]) => r === release)
  return known ? `Terraria ${known[1]}` : t('world version {release}', { release })
}

/** La versione di destinazione è più vecchia di quella che ha salvato il mondo (se entrambe note). */
export const olderThanWorld = (target: number | null | undefined, world: number | null | undefined) =>
  target !== null && target !== undefined && world !== null && world !== undefined && target < world

/** Confronto tra versioni "1.4.5.8" / "2026.09.3.1" (numerico per parti). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** "tModLoader 2026.09.3.1 (Terraria 1.4.4.9) — fissa", con il percorso se l'installazione non è gestita dal pannello. */
export const choiceLabel = (c: InstallationChoice) => `${GAME_LABEL[c.kind]} ${versionLabel(c)}`

/** Solo la parte di versione dell'etichetta: "6.2.1 (Terraria 1.4.5.8) — principale". */
export const versionLabel = (c: InstallationChoice) => {
  if (!c.installed) return c.installing ? `${c.version ?? ''} — ${t('installing')}` : c.pinned ? `${c.version} — ${t('to install')}` : `${t('latest version')} — ${t('to install')}`
  const game = c.kind !== 'terraria' && c.gameVersion ? ` (Terraria ${c.gameVersion})` : ''
  const role = !c.managed ? ` — ${c.path}` : c.pinned ? ` — ${t('pinned')}` : ` — ${t('main')}`
  return `${c.version ?? '?'}${game}${role}`
}

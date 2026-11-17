export type ServerAbility = 'view' | 'console' | 'power' | 'mods' | 'files'
export const SERVER_ABILITIES: ServerAbility[] = ['view', 'console', 'power', 'mods', 'files']

export type User = {
  id: number
  name: string
  email: string
  isAdmin: boolean
  isApproved: boolean
  approvedAt: string | null
  createdAt: string | null
  /** server → permessi; null per gli admin (= tutto) */
  servers: Record<string, ServerAbility[]> | null
}

export type ServerState = 'stopped' | 'starting' | 'running' | 'stopping'
/** Terraria vanilla o tModLoader (mod, Workshop e modpack solo con tModLoader). */
export type Game = 'terraria' | 'tmodloader'
export const GAME_LABEL: Record<Game, string> = { terraria: 'Terraria', tmodloader: 'tModLoader' }
export type PowerAction = 'start' | 'stop' | 'restart'

export type Server = {
  id: string
  name: string
  state: ServerState
  operation: PowerAction | null
  managed: boolean
  pid: number | null
  subworlds: number
  uptimeSeconds: number | null
  cpuPercent: number | null
  memoryBytes: number | null
  players: { online: number; max: number }
  world: string | null
  port: number
  hasPassword: boolean
  game: Game
  /** Versione installata del gioco (Terraria o tModLoader). */
  version: string | null
  tmlVersion: string | null
  /** Mod cambiate dopo l'avvio: servono un riavvio per essere applicate. */
  restartRequired: boolean
  lastError: { operation: PowerAction; message: string; at: string } | null
}

export type Invitation = {
  id: number
  email: string | null
  createdBy: string | null
  usedBy: string | null
  expiresAt: string
  usedAt: string | null
  status: 'active' | 'used' | 'expired'
  createdAt: string | null
}

export type Mod = {
  name: string
  file: string
  displayName: string | null
  version: string | null
  tmlVersion: string | null
  author: string | null
  description: string | null
  homepage: string | null
  side: 'both' | 'client' | 'server' | 'noSync' | null
  dependencies: string[]
  optionalDependencies: string[]
  size: number
  modifiedAt: string
  enabled: boolean
  missingDependencies: string[]
  error: string | null
  /** Il .tmod ha un'icona. */
  hasIcon?: boolean
  /** ID della pagina del Workshop collegata, se c'è. */
  workshopId: string | null
  /** Dati della pagina del Workshop, dal database del sito (null se non collegata o non trovata). */
  workshop: ModWorkshop | null
}

export type ModWorkshop = {
  id: string
  title: string | null
  tags: string[]
  previewUrl: string | null
  subscriptions: number | null
  updatedAt: string | null
}

export type ModList = { mods: Mod[]; missingEnabled: string[] }

export type Modpack = {
  id: string
  name: string
  description: string
  mods: string[]
  /** Mod → versione bloccata (le altre seguono gli aggiornamenti). */
  versions: Record<string, string>
  active: boolean
  createdAt?: string
  state: 'enabled' | 'partial' | 'disabled'
  /** Mod non installate (e non recuperabili dall'archivio). */
  missing: string[]
  /** Versione bloccata non più disponibile. */
  unavailable: string[]
  /** Versioni che l'attivazione cambierà prendendole dall'archivio. */
  toSwitch: { name: string; from: string | null; to: string }[]
}

export type ModpackActivationResult = {
  enabled?: string[]
  disabled?: string[]
  kept?: string[]
  /** Altri pack segnati come disattivi da «attiva solo questo». */
  deactivated?: string[]
  switched?: { name: string; from: string | null; to: string }[]
}

export type ArchivedVersion = { version: string; tmlVersion: string; size: number; archivedAt: string }

export type ArchiveEntry = {
  name: string
  displayName: string | null
  installedVersion: string | null
  versions: ArchivedVersion[]
}

export type UploadResult = {
  mod: Mod
  replacedVersion: string | null
  enabled: string[]
  warning: string | null
}

export type TrashItem = {
  id: string
  kind: 'file' | 'mod'
  name: string
  root: string | null
  path: string | null
  modName: string | null
  modVersion: string | null
  reason: 'deleted' | 'replaced'
  isDir: boolean
  size: number
  deletedAt: string
  expiresAt: string
  daysLeft: number
}

export type ImportablePack = { name: string; format: 'json' | 'folder'; mods: number; files: number }

export type ModpackImportResult = {
  pack: { id: string; name: string; mods: string[] }
  installed: string[]
  updated: string[]
  skipped: { name: string; reason: string }[]
  missing: string[]
}

export type ServerSettings = {
  id: string
  name: string
  game: Game
  installDir: string
  /** Versione del mondo attuale (null se non ancora generato). */
  worldRelease: number | null
  saveDir: string
  configPath: string
  launchArgs: string[]
  port: number
  maxPlayers: number
  hasPassword: boolean
  motd: string
  world: string | null
  worldName: string | null
  /** Altre chiavi di serverconfig.txt presenti nel file (le assenti valgono il default di Terraria). */
  config: Record<string, string>
}

export type TmlJob = {
  installDir: string
  kind: 'install' | 'update' | 'rollback'
  fromVersion: string | null
  toVersion: string | null
  phase: 'download' | 'extract' | 'prepare' | 'stopping' | 'swap' | 'starting' | 'done' | 'error'
  progress: number | null
  message: string
  startedAt: string
  finishedAt: string | null
  error: string | null
  restarted: string[]
}

export type Installation = {
  id: string
  path: string
  kind: Game
  /** L'installazione predefinita del pannello (nella cartella dati). */
  managed: boolean
  /** false = gioco non ancora installato in questa cartella. */
  installed: boolean
  version: string | null
  /** Versione di Terraria (per tModLoader: quella su cui è basato). */
  gameVersion: string | null
  /** Versione dei mondi che sa aprire; null se non nota. */
  worldRelease: number | null
  servers: { id: string; name: string; worldRelease: number | null }[]
  backups: { path: string; version: string | null; modifiedAt: string }[]
  job: TmlJob | null
}

export type TmlRelease = {
  version: string
  prerelease: boolean
  publishedAt: string | null
  url: string
  size: number | null
  /** Versione dei mondi salvati da questa versione, se nota. */
  worldRelease: number | null
}

/** Installazione utilizzabile da un server (form di creazione e cambio di versione). */
export type InstallationChoice = Pick<Installation, 'path' | 'kind' | 'version' | 'gameVersion' | 'worldRelease' | 'managed' | 'installed'> & {
  /** Installazione in corso. */
  installing: boolean
}

// --- Steam Workshop ----------------------------------------------------------------------------

export type ModUpdateStatus = 'current' | 'update' | 'maybe' | 'incompatible' | 'unlinked' | 'unavailable'

export type ModUpdate = {
  name: string
  displayName: string | null
  installedVersion: string | null
  workshopId: string | null
  link: 'auto' | 'manual' | null
  title: string | null
  url: string | null
  latestVersion: string | null
  newerVersion: string | null
  newerRequiresTml: string | null
  timeUpdated: string | null
  status: ModUpdateStatus
}

export type UpdateReport = {
  apiKey: boolean
  steamcmd: boolean
  steamcmdProblem: string | null
  tmlVersion: string | null
  checkedAt: string
  mods: ModUpdate[]
}

export type UpdateJobItem = {
  name: string
  workshopId: string
  dependency: boolean
  /** Mod nuova scelta dal Workshop: installata senza abilitarla. */
  install?: boolean
  from: string | null
  to: string | null
  state: 'queued' | 'downloading' | 'installing' | 'done' | 'skipped' | 'error' | 'cancelled'
  message: string | null
  bytes?: number | null
  totalBytes?: number | null
}

export type UpdateJob = {
  serverId: string
  state: 'running' | 'done' | 'error'
  startedAt: string
  finishedAt: string | null
  items: UpdateJobItem[]
  warnings: string[]
}

export type WorkshopSearchResult = {
  id: string
  title: string | null
  modName: string | null
  url: string
  subscriptions: number | null
  timeUpdated: string | null
  tags: string[]
}

export type BrowseSort = 'relevance' | 'popular' | 'trend' | 'recent' | 'updated' | 'votes'

export type BrowseItem = {
  id: string
  title: string | null
  modName: string | null
  url: string
  tags: string[]
  previewUrl: string | null
  subscriptions: number | null
  fileSize: number | null
  timeUpdated: string | null
  timeCreated: string | null
  description: string | null
  /** Versione della mod adatta alla tModLoader del server. */
  compatibleVersion: string | null
  /** Nessuna build per la tModLoader del server: da quale tModLoader funziona. */
  requiresTml: string | null
  /** ID delle dipendenze dichiarate nel Workshop. */
  dependencies: string[]
}

export type BrowsePage = { tmlVersion: string | null; total: number; nextCursor: string | null; items: BrowseItem[] }

export type BrowseDetails = BrowseItem & {
  images: string[]
  dependencyItems: { id: string; title: string | null; modName: string | null }[]
}

/** Mod installata dal Workshop e non ancora abilitata. */
export type PendingMod = Pick<Mod, 'name' | 'displayName' | 'version' | 'missingDependencies'>

export type ApplyPendingResult = { enabled: string[]; failed: { name: string; message: string }[] }

import { resolve } from 'node:path'

const agentRoot = resolve(import.meta.dirname, '..')
/** Radice del progetto (la cartella clonata da git). */
export const projectRoot = resolve(agentRoot, '..')

/** "7777-7787" → { min, max }; null se non impostato o non valido. */
export function parsePortRange(text: string | undefined): { min: number; max: number } | null {
  const match = text?.trim().match(/^(\d{1,5})(?:-(\d{1,5}))?$/)
  if (!match) return null
  const min = Number(match[1])
  const max = Number(match[2] ?? match[1])
  return min >= 1024 && max <= 65535 && min <= max ? { min, max } : null
}

export const config = {
  host: process.env.AGENT_HOST ?? '127.0.0.1',
  port: Number(process.env.AGENT_PORT ?? 7878),
  token: process.env.AGENT_TOKEN ?? '',
  /**
   * Cartella unica con tutti i dati (server, mod, tModLoader, database…): vedi paths.ts.
   * TMM_DATA_DIR è condivisa con Laravel; i percorsi relativi partono dalla radice del progetto.
   */
  dataDir: resolve(projectRoot, process.env.TMM_DATA_DIR ?? process.env.AGENT_DATA_DIR ?? 'data'),
  /** Secondi massimi di attesa perché il server apra la porta dopo l'avvio (le mod grosse sono lente). */
  startTimeout: Number(process.env.AGENT_START_TIMEOUT ?? 600),
  /** Secondi massimi di attesa perché il server salvi e si chiuda dopo "exit". */
  stopTimeout: Number(process.env.AGENT_STOP_TIMEOUT ?? 180),
  /**
   * Quando l'agent riceve SIGTERM/SIGINT spegne i server (con "exit": il mondo viene salvato) e al
   * riavvio riaccende quelli che erano accesi. Serve in Docker, dove i server vivono nel container
   * dell'agent; con systemd (KillMode=process) i server sopravvivono all'agent e va lasciato spento.
   */
  stopServersOnExit: /^(1|true|yes|on)$/i.test(process.env.AGENT_STOP_SERVERS_ON_EXIT ?? ''),
  /**
   * Porte dei server di gioco consentite (TMM_GAME_PORTS, es. "7777-7787"). In Docker sono quelle
   * pubblicate dal container: una porta fuori intervallo non sarebbe raggiungibile dall'esterno.
   */
  gamePorts: parsePortRange(process.env.TMM_GAME_PORTS),
  /** Giorni dopo cui gli elementi del cestino vengono cancellati definitivamente. */
  trashRetentionDays: Number(process.env.AGENT_TRASH_RETENTION_DAYS ?? 30),
  /** Repository GitHub da cui scaricare le versioni di tModLoader. */
  tmlRepository: process.env.AGENT_TML_REPOSITORY ?? 'tModLoader/tModLoader',
  /**
   * Chiave Steam Web API (facoltativa): dà versioni delle mod e ricerca nel Workshop.
   * Resta solo nell'agent: non viene mai inviata a Laravel né al browser.
   */
  steamApiKey: (process.env.STEAM_API_KEY ?? '').trim(),
  /** steamcmd già installato altrove (facoltativo); di default viene scaricato in data/steamcmd. */
  steamcmdOverride: process.env.AGENT_STEAMCMD ? resolve(process.env.AGENT_STEAMCMD) : null,
}

import { join } from 'node:path'
import { config } from './config.js'

/**
 * Tutti i percorsi su disco dell'agent, sotto un'unica cartella dati (config.dataDir, di default
 * <progetto>/data). Copiare o cancellare quella cartella = spostare o rimuovere tutto.
 *
 *   data/
 *   ├── servers.json             registry dei server
 *   ├── workshop.json            collegamenti mod → Workshop
 *   ├── pending-enable.json      mod del Workshop in attesa di essere abilitate
 *   ├── resume-servers.json      server da riaccendere dopo uno spegnimento dell'agent
 *   ├── database.sqlite          database del sito (Laravel)
 *   ├── terraria/Terraria/       dedicated server di Terraria vanilla (+ Terraria-v<versione>: backup)
 *   ├── terraria/versions/<v>/   versioni aggiuntive di Terraria, fisse (più server su versioni diverse)
 *   ├── tmodloader/tModLoader/   installazione di tModLoader (+ tModLoader-v<versione>: backup)
 *   ├── steamcmd/                steamcmd (scaricato al primo uso)
 *   ├── servers/<id>/
 *   │   ├── serverconfig.txt
 *   │   ├── save/                -tmlsavedirectory: Mods/, ModConfigs/, Worlds/
 *   │   ├── logs/                console.log, console.log.1, console.session
 *   │   ├── modpacks.json
 *   │   ├── mods-state.json      impronta delle mod all'avvio (avviso "riavvio necessario")
 *   │   ├── archive/<Mod>/<versione>.tmod
 *   │   └── trash/<elemento>/
 *   ├── cache/                   download del Workshop, screenrc
 *   └── tmp/
 *
 * I metadati di un server stanno sempre in servers/<id>/, anche quando il suo save/ è altrove
 * (server registrati a mano con un saveDir esterno).
 */
export const paths = {
  registry: () => join(config.dataDir, 'servers.json'),
  workshopLinks: () => join(config.dataDir, 'workshop.json'),
  pendingEnable: () => join(config.dataDir, 'pending-enable.json'),
  /** Server spenti dallo spegnimento dell'agent, da riaccendere al prossimo avvio. */
  resumeServers: () => join(config.dataDir, 'resume-servers.json'),
  tmp: () => join(config.dataDir, 'tmp'),
  cache: () => join(config.dataDir, 'cache'),
  screenrc: () => join(config.dataDir, 'cache', 'screenrc'),
  workshopDownloads: () => join(config.dataDir, 'cache', 'workshop'),

  /** Installazione di Terraria vanilla gestita dal pannello. */
  terrariaInstall: () => join(config.dataDir, 'terraria', 'Terraria'),
  /** Versioni aggiuntive di Terraria (una cartella per versione, non si aggiornano). */
  terrariaVersions: () => join(config.dataDir, 'terraria', 'versions'),
  terrariaVersion: (version: string) => join(config.dataDir, 'terraria', 'versions', version),
  /** Installazione di tModLoader gestita dal pannello. */
  tmlInstall: () => join(config.dataDir, 'tmodloader', 'tModLoader'),
  steamcmdDir: () => join(config.dataDir, 'steamcmd'),
  steamcmd: () => config.steamcmdOverride ?? join(config.dataDir, 'steamcmd', 'steamcmd.sh'),

  serversRoot: () => join(config.dataDir, 'servers'),
  server: (id: string) => join(config.dataDir, 'servers', id),
  serverSave: (id: string) => join(config.dataDir, 'servers', id, 'save'),
  serverConfig: (id: string) => join(config.dataDir, 'servers', id, 'serverconfig.txt'),
  serverLogs: (id: string) => join(config.dataDir, 'servers', id, 'logs'),
  modpacks: (id: string) => join(config.dataDir, 'servers', id, 'modpacks.json'),
  modsState: (id: string) => join(config.dataDir, 'servers', id, 'mods-state.json'),
  archive: (id: string) => join(config.dataDir, 'servers', id, 'archive'),
  trash: (id: string) => join(config.dataDir, 'servers', id, 'trash'),
}

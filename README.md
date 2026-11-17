# tModManager

Pannello web per creare e gestire server Terraria / tModLoader: console in tempo reale, mod e Steam Workshop,
modpack, file, utenti con permessi per server. Si installa con un comando e gira in Docker.

```
backend/   Laravel 13 (API REST, auth Sanctum, SQLite)
frontend/  React + Vite + TypeScript (SPA)
agent/     Demone Node.js (Fastify): avvia i server in sessioni screen, gestisce processi e file
docker/    immagini (web: FrankenPHP; agent: Node + screen + librerie per tModLoader/steamcmd)
```

Laravel non tocca mai processi o file dei server: passa sempre dall'agent (HTTP con un token condiviso,
`AGENT_TOKEN`).

## Installazione (Docker)

```bash
curl -fsSL https://raw.githubusercontent.com/Jtgabry/tmodmanager/main/install.sh | bash
```

oppure, clonando a mano:

```bash
git clone https://github.com/Jtgabry/tmodmanager.git && cd tmodmanager && ./install.sh
```

Con `curl | bash` il progetto viene scaricato in `~/tmodmanager` (`TMM_DIR` per cambiarlo); le opzioni vanno dopo
`bash -s --`, es. `… | bash -s -- --domain tmm.example.com`.

L'installer controlla la macchina (Linux x86_64), installa Docker se manca (script ufficiale, chiede conferma e
sudo), chiede dominio, porte dei server di gioco e chiave Steam (facoltativa), genera `.env` con i segreti, avvia i
container e stampa l'indirizzo con il codice per creare l'amministratore. Se le porte 80/443 sono già occupate
(Apache/nginx) usa la modalità proxy e stampa la configurazione da aggiungere al server web. Opzioni per
l'installazione senza domande: `./tmm install --help`.

Le immagini Docker arrivano già pronte da GitHub: `.github/workflows/images.yml` a ogni push su `main` esegue i
test e pubblica `ghcr.io/jtgabry/tmodmanager-web` e `-agent` (tag `latest`, `sha-<commit>`, e `<versione>` per i tag
`v*`). `tmm` le scarica (`TMM_IMAGES=registry`, `TMM_IMAGE_TAG` per fissare una versione); se non può — repository
privata senza `docker login ghcr.io`, nessuna rete — le costruisce sulla macchina. `./tmm install --build` o
`TMM_IMAGES=build` per costruirle sempre in locale.

| Comando | |
|---|---|
| `tmm status` · `tmm logs [web\|agent]` | stato dei container, URL, spazio occupato · log |
| `tmm start` · `tmm stop` · `tmm restart` | `stop`: i server salvano il mondo e si spengono; allo `start` si riaccendono |
| `tmm update` | `git pull`, immagini nuove (scaricate o ricostruite), riavvio solo dei container cambiati |
| `tmm backup [file]` | `backups/tmodmanager-<data>.tar.gz` con `data/` e `.env` (senza cache) |
| `tmm restore <file>` | ripristino, anche su una macchina nuova (installa Docker se manca) |
| `tmm setup-code` | codice per creare il primo amministratore |
| `tmm uninstall` | backup, rimozione di container e immagini; dati e Docker solo con conferma esplicita |

Tutto ciò che crea l'installazione sta nella cartella del progetto (`.env`, `data/`, `backups/`), più il link
`~/.local/bin/tmm` e, se installato da `tmm`, Docker stesso.

### Docker a mano

```bash
cp .env.example .env      # riempi APP_URL, TMM_SITE_ADDRESS, APP_KEY, AGENT_TOKEN, TMM_UID/TMM_GID
mkdir -p data             # deve appartenere a TMM_UID (altrimenti Docker la crea come root)
docker compose up -d --build
docker compose exec web php artisan setup:code   # codice e indirizzo per creare l'amministratore
```

Due container (`docker/`), entrambi con la cartella dati montata in `/srv/tmm-data`:

- **web** — FrankenPHP (Caddy + PHP 8.4): SPA, API Laravel su SQLite, `/ws/` inoltrato all'agent. Con un dominio in
  `TMM_SITE_ADDRESS` fa HTTPS da solo (certificati in `data/web/caddy`); con `:80` solo HTTP. Gira come `TMM_UID`.
  All'avvio applica le migrazioni e mette in cache config e rotte. Storage di Laravel in `data/web/storage`.
- **agent** — Node + screen + librerie per tModLoader/steamcmd (solo x86_64). I server di gioco girano qui dentro;
  le porte `TMM_GAME_PORTS` sono pubblicate e il pannello propone solo quelle. Parte come root solo per creare
  l'utente `TMM_UID` (serve a screen), poi passa a quell'utente: i file in `data/` restano del proprietario.
  `docker compose stop` → i server salvano e si spengono (`stop_grace_period: 200s`), al riavvio si riaccendono.
  Ogni giorno alle `AGENT_BACKUP_TIME` (default `04:00`, ora locale: `TMM_TZ` o `/etc/localtime` dell'host) fa il
  backup dei mondi di tutti i server in `data/servers/<id>/backups/` (`<Mondo>_backup_<YmdHis>.zip`), tenendo gli
  ultimi `AGENT_BACKUP_KEEP` (14) automatici; niente cron da configurare.

Dietro un proxy già presente (es. Apache sulla 443): `TMM_SITE_ADDRESS=:80`, `TMM_HTTP_BIND=127.0.0.1:8080`,
`TRUSTED_PROXIES=127.0.0.1,172.16.0.0/12`, e nel proxy `ProxyPass / http://127.0.0.1:8080/` (più
`ProxyPass /ws/ ws://127.0.0.1:8080/ws/` prima, per la console).

## Sviluppo

```bash
cp backend/.env.example backend/.env && cp agent/.env.example agent/.env   # stesso AGENT_TOKEN nei due file
cd backend  && composer install && php artisan key:generate && php artisan migrate && php artisan serve
cd frontend && npm install && npm run dev      # http://localhost:5173 (proxy /api → :8000)
cd agent    && npm install && npm run dev      # http://127.0.0.1:7878 (serve screen; per steamcmd lib32gcc-s1)
cd backend  && php artisan setup:code          # codice per la pagina "Crea l'amministratore"
```

Test: `cd agent && npm test` · `cd backend && php artisan test` · `cd frontend && npm run build`.

## Dati

Tutto sta in un'unica cartella, `data/` alla radice del progetto (`TMM_DATA_DIR`, condivisa da Laravel e agent;
non versionata). Copiarla o cancellarla = spostare o rimuovere tutto. Struttura completa in `agent/src/paths.ts`:

```
data/
├── servers.json, workshop.json     registry dei server, collegamenti al Workshop
├── database.sqlite                 database del sito (con DB_CONNECTION=sqlite)
├── tmodloader/tModLoader/          tModLoader (+ tModLoader-v<versione>: backup)
├── steamcmd/                       scaricato al primo uso
├── servers/<id>/                   serverconfig.txt, save/ (Mods, ModConfigs, Worlds), logs/,
│                                   modpacks.json, archive/, trash/
├── cache/                          download del Workshop
└── tmp/
```

Aprendo il sito senza amministratori compare la pagina **Crea l'amministratore** (serve il codice monouso di
`setup:code`). Poi, da *Gestione server*: installa Terraria (da terraria.org) e, per le mod, tModLoader (da GitHub), poi crea il primo server.
steamcmd viene scaricato da solo al primo download dal Workshop.

Da installazioni precedenti: la vecchia cartella `agent/data` viene spostata qui in automatico al primo avvio
dell'agent; per passare da MariaDB a SQLite: `DB_CONNECTION=sqlite` in `backend/.env` (lasciando i `DB_*` di
MariaDB), `php artisan migrate`, `php artisan db:import-from mariadb`.

## Funzioni

- **Server**: stato (giocatori, CPU, RAM, uptime, versione tML), avvio/arresto/riavvio, avviso "riavvio necessario".
- **Console**: output in tempo reale via WebSocket (`/ws/` inoltrato all'agent, autenticato da un ticket
  firmato da Laravel); se il WebSocket non è disponibile ripiega sul polling ogni secondo. Invio comandi via Laravel.
- **Mod**: elenco con dipendenze lette dai `.tmod`, abilita/disabilita (dipendenze automatiche), carica/aggiorna
  (la versione precedente va nel cestino), elimina (cestino), scarica.
- **Steam Workshop**: le mod vengono collegate in automatico alla loro pagina del Workshop (nome interno, con l'aiuto
  di `Mods/install.txt`) o a mano; il pannello mostra gli aggiornamenti per la versione di tModLoader del server e li
  scarica con steamcmd (anonimo), installando anche le dipendenze nuove. Senza chiave Steam Web API si confrontano
  solo le date.
- **Modpack**: gruppi di mod attivabili/disattivabili; importazione dei modpack di tModLoader (cartella
  `Mods/ModPacks` del server, oppure upload del `.json` o della cartella del pack in `.zip`).
- **File**: SaveData e mondi: naviga, carica, scarica (cartelle come `.zip`), rinomina, elimina (cestino), modifica i
  file di testo. Della cartella di tModLoader si vedono solo i `.txt` di primo livello e `tModLoader-Logs/`.
- **Cestino**: file e mod eliminati o sostituiti, con ripristino; cancellazione automatica dopo 30 giorni.
- **Gestione server** (admin): creazione di nuovi server (cartella in `data/servers/<id>`, mondo generato al primo
  avvio, mod copiabili da un altro server), impostazioni (porta, giocatori, password, motd), rimozione dal pannello.
- **tModLoader** (admin): installazione e aggiornamento da GitHub (verifica sha256, spegnimento e riaccensione dei server, backup
  della versione precedente in `<installazione>-v<versione>`, si tengono gli ultimi 2) e ritorno a un backup.
- **Utenti**: registrazione con approvazione o invito, permessi per server (`view`, `console`, `power`, `mods`, `files`).

## Agent

- Variabili facoltative in `agent/.env`: `AGENT_TRASH_RETENTION_DAYS` (30), `AGENT_START_TIMEOUT`,
  `AGENT_STOP_TIMEOUT`, `STEAM_API_KEY` (resta nell'agent), `AGENT_STEAMCMD` (steamcmd già installato altrove).
- `AGENT_STOP_SERVERS_ON_EXIT=1` (per Docker): quando l'agent riceve SIGTERM/SIGINT manda `exit` a tutti i server,
  aspetta che salvino il mondo (fino a `AGENT_STOP_TIMEOUT`), annota quelli accesi in `data/resume-servers.json` e al
  riavvio li riaccende. Un secondo segnale fa uscire subito. Senza Docker (es. con systemd e `KillMode=process`) va
  lasciato spento: i server sopravvivono ai riavvii dell'agent.
- steamcmd: scaricato in `data/steamcmd` (tarball ufficiale di Valve); è a 32 bit e fuori da Docker richiede
  `lib32gcc-s1`.

## Licenza

[MIT](LICENSE). Progetto indipendente, non affiliato a Re-Logic (Terraria) né al team di tModLoader.

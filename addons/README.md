# Add-on di tModManager

Componenti scritti per il pannello e distribuiti con lui. Ogni cartella è un add-on; l'agent li elenca in
`agent/src/addons.ts`. Si aggiornano insieme al pannello. Due tipi:

- **plugin TShock** (`<Nome>/<Nome>.csproj`, .NET 9) → `dist/<Nome>.dll`. Compaiono tra i plugin di ogni server
  TShock, **disattivati** finché non li si attiva dalla sezione Plugin; un add-on attivo viene sostituito dalla build
  nuova (vale al riavvio del server). Voce in `ADDONS`.
- **mod tModLoader** (con `build.txt`, .NET 8) → `dist/<Nome>.tmod`. Compaiono nel **Workshop** del pannello come una
  mod da installare, anche senza la chiave di Steam (ID `tmm-<Nome>`). "Installa" copia il `.tmod` in `Mods/` (in
  attesa di essere abilitata, come le mod scaricate); da lì è una mod come le altre: si abilita, si aggiunge ai
  modpack, si scarica, si elimina. Non viene mai collegata allo Steam Workshop né esportata con i modpack (zip ed
  elenco .json): resta sul server. La copia in `Mods/` viene sostituita da quella del pannello prima di ogni avvio del
  server e quando si apre l'elenco delle mod. Voce in `MOD_ADDONS`.

Compilazione:

- Nell'immagine Docker dell'agent: uno stage .NET SDK esegue `build.sh` e copia `dist/` in `/app/addons`.
- In sviluppo: `addons/build.sh` (SDK .NET 9) crea `addons/dist/`, che l'agent legge da lì (`AGENT_ADDONS_DIR`).
  Senza, gli add-on semplicemente non compaiono.

Versioni per la compilazione:

- TShock in `Directory.Packages.props`: l'API dei plugin (`ApiVersion 2.1`) è la stessa per tutta TShock 6, quindi la
  .dll vale per tutti i server TShock 6.
- tModLoader in `tmodloader.version` (tag della release di GitHub): `build.sh` scarica lo zip in `.tml/` e usa solo
  `tModLoader.dll` e `Libraries/` come riferimenti, senza avviarlo (oppure `TML_PATH=<installazione>`). Va tenuta la
  versione stabile **più vecchia** che si vuole supportare: tModLoader rifiuta le mod compilate per una versione più
  nuova della sua (il Workshop del pannello lo segnala: "Richiede tModLoader …"), mentre accetta le più vecchie.
- Il `.tmod` lo crea `tools/TmodPack` (stesso formato di tModLoader: intestazione, hash SHA1, `Info` con le proprietà
  di `build.txt`, la .dll, la .pdb, `icon.png`), senza avviare tModLoader.

`tools/WorldFrames` non è un add-on: calcola i frame di blocchi e muri (quale parte del foglio di sprite usare) con
il codice di Terraria, tramite OTAPI, come il client quando riceve il mondo. L'agent lo usa per la mappa ricavata dal
file del mondo, senza LiveMap: gli passa i dati delle tile dei riquadri cambiati (e dei vicini, i bordi dipendono
da loro) e riceve gli stessi dati con i frame; un riquadro alla volta, in una finestra con un margine di tile, con un
seme fisso per le varianti casuali (a parità di mondo, stessi frame). Nell'immagine Docker c'è il runtime .NET apposta.
I blocchi delle mod non li conosce: per i vicini valgono come pietra, e il loro frame resta al pannello.

`tools/MapColors` non è un add-on: durante la build ricava da Terraria (tramite OTAPI, `MapHelper.Initialize()`)
i colori della minimappa e li scrive in `dist/map-colors.json`. L'agent li usa per disegnare la mappa dai file del
mondo (`.wld`) di qualsiasi server, anche senza LiveMap. Nessuna tabella di colori copiata a mano nel repository: si
rigenera a ogni build, quindi segue la versione di Terraria in `Directory.Packages.props`.

## LiveMap

Mappa del mondo in tempo reale per la sezione **Mondo** del pannello, in due versioni con lo stesso motore
(`Shared/`: `MapEngine.cs` pianifica il disegno, `MapWriter.cs` e `Png.cs` scrivono su disco):

| | Plugin TShock (`LiveMap/`) | Mod tModLoader (`TmmLiveMap/`, nome visibile "LiveMap") |
| --- | --- | --- |
| Cartella (nel save/ del server) | `tshock/map/` | `LiveMap/` |
| Configurazione | `tshock/LiveMap.json`, ricaricata con `/reload` | `LiveMap/config.json`, ricaricata con `/mappa ricarica` |
| Comandi | `/mappa`, `/mappa rigenera` (permesso `livemap.admin`) | `/mappa`, `/mappa rigenera`, `/mappa ricarica` (console del server) |
| Colori | minimappa di Terraria (`MapHelper`) | minimappa del gioco, anche per blocchi e muri delle mod (`AddMapEntry`) |

La mod è `side = Server`: i giocatori non la scaricano. Sul server dedicato tModLoader non prepara le tabelle della
minimappa: le prepara la mod (`MapColors` in `TmmLiveMap.cs`), e una modifica IL toglie da `MapHelper.CreateMapTile`
le letture di `Main.Map` (la mappa esplorata dal giocatore, che sul server non c'è).

Vista ravvicinata con gli sprite: oltre alla mappa a pixel, per ogni riquadro LiveMap scrive i dati grezzi delle
tile (`tiles/`, formato in `Shared/TileData.cs`: tipo, frame, muro e suo frame, forma, vernice) e in `types.json`
quali tipi sono delle mod e con quale texture. Il browser disegna blocchi, muri e liquidi con i loro sprite, che l'agent
prende dai `.tmod` per le mod e, per Terraria, dalle texture del gioco in `data/terraria-assets/<versione>/Images/`
(`Tiles_*.xnb` e `Wall_*.xnb` copiati da un'installazione del gioco: non sono sul server né nel repository; l'agent
li decomprime, LZX, e li converte in PNG una volta). I frame (quale parte del foglio di sprite) caricando il mondo
restano solo per mobili e oggetti di più tile; per gli altri blocchi e per i muri li calcola LiveMap, una volta per
tile a ogni avvio e dentro il limite di tempo per tick: la mod con `WorldGen.TileFrame` e `Framing.WallFrame` senza
"azioni" (come `WorldGen.EveryTileFrame` dopo la generazione di un mondo), così anche gli schemi di frame delle mod
sono giusti; il plugin con `WorldGen.TileFrameCosmetic` (in Terraria 1.4.5 la scelta del frame, senza gli effetti
di `TileFrame`) e `Framing.WallFrame`.

File scritti:

| File | Contenuto |
| --- | --- |
| `manifest.json` | mondo (nome, id, dimensioni, spawn, superficie), griglia dei riquadri e loro versioni (`chunks`, riga per riga, 0 = non ancora disegnato), panoramica, avanzamento |
| `chunks/{cx}_{cy}.png` | riquadri da 200×150 tile, un pixel per tile, con i colori della minimappa |
| `tiles/{cx}_{cy}.bin` | dati grezzi delle stesse tile (gzip), con la stessa versione del PNG |
| `types.json` | tipi di blocchi e muri: frame salvati o no, e mod e texture di quelli delle mod |
| `overview.png` | mondo intero ridotto (`ScalaPanoramica`, default 1 pixel ogni 4×4 tile), dopo il primo giro completo |
| `players.json` | giocatori: nome, posizione in tile, team, vita, morto |
| `viewer` | lo **tocca il pannello** finché la mappa è aperta; senza, LiveMap resta in pausa |

Le versioni sono istanti in ms e crescono a ogni riscrittura: il pannello ricarica solo i riquadri cambiati.

Carico sul server:

- in pausa se nessuno guarda (`SecondiSenzaSpettatori`, default 120 s dall'ultimo tocco di `viewer`);
  le modifiche intanto si segnano e alla riapertura si ridisegnano quei riquadri;
- disegno sul thread di gioco a righe, al massimo `MillisecondiPerTick` (default 1 ms su 16,6 di un tick); a server
  vuoto il gioco non aggiorna il mondo, e il disegno continua con un timer, con lo stesso limite;
- PNG, panoramica e file scritti da un thread a parte; un riquadro identico al precedente non si riscrive;
- modifiche scoperte dai pacchetti che il server manda ai client (blocchi, aree, liquidi, vernice, mobili),
  con `MillisecondiAttesaModifiche` per raggruppare gli scavi; una rilettura a rotazione
  (`MinutiTraRiletture`) copre il poco che sfugge.

Per provarla senza pannello: `"SempreAttiva": true` nella configurazione, poi `/reload` (TShock) o
`/mappa ricarica` (tModLoader).

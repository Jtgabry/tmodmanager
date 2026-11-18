# Add-on di tModManager

Plugin TShock scritti per il pannello. Ogni cartella è un add-on; l'agent li elenca in `agent/src/addons.ts`.
Compaiono tra i plugin di ogni server TShock, **disattivati** finché non li si attiva dalla sezione Plugin, e si
aggiornano insieme al pannello (un add-on attivo viene sostituito dalla build nuova; vale al riavvio del server).

- Nell'immagine Docker dell'agent vengono compilati da uno stage .NET SDK e copiati in `/app/addons`.
- In sviluppo: `addons/build.sh` (serve l'SDK .NET 9) crea `addons/dist/<Nome>.dll`, che l'agent legge da lì
  (`AGENT_ADDONS_DIR`). Senza, gli add-on semplicemente non compaiono.

Versione di TShock per la compilazione in `Directory.Packages.props`: l'API dei plugin (`ApiVersion 2.1`) è la
stessa per tutta TShock 6, quindi la .dll vale per tutti i server TShock 6.

`tools/MapColors` non è un add-on: durante la build ricava da Terraria (tramite OTAPI, `MapHelper.Initialize()`)
i colori della minimappa e li scrive in `dist/map-colors.json`. L'agent li usa per disegnare la mappa dai file del
mondo (`.wld`) di qualsiasi server, anche senza LiveMap. Nessuna tabella di colori copiata a mano nel repository: si
rigenera a ogni build, quindi segue la versione di Terraria in `Directory.Packages.props`.

Per aggiungere un add-on: una cartella `<Nome>/` con `<Nome>.csproj` (titolo, descrizione e versione nel
`PropertyGroup`) e una voce in `ADDONS` in `agent/src/addons.ts`.

## LiveMap

Mappa del mondo in tempo reale per il pannello. Scrive nel save/ del server, in `tshock/map/`:

| File | Contenuto |
| --- | --- |
| `manifest.json` | mondo (nome, id, dimensioni, spawn, superficie), griglia dei riquadri e loro versioni (`chunks`, riga per riga, 0 = non ancora disegnato), panoramica, avanzamento |
| `chunks/{cx}_{cy}.png` | riquadri da 200×150 tile, un pixel per tile, con i colori della minimappa di Terraria |
| `overview.png` | mondo intero ridotto (`ScalaPanoramica`, default 1 pixel ogni 4×4 tile), dopo il primo giro completo |
| `players.json` | giocatori: nome, posizione in tile, team, vita, morto |
| `viewer` | lo **tocca il pannello** finché la mappa è aperta; senza, il plugin resta in pausa |

Le versioni sono istanti in ms e crescono a ogni riscrittura: il pannello ricarica solo i riquadri cambiati.

Carico sul server:

- in pausa se nessuno guarda (`SecondiSenzaSpettatori`, default 120 s dall'ultimo tocco di `viewer`);
  le modifiche intanto si segnano e alla riapertura si ridisegnano quei riquadri;
- disegno sul thread di gioco a righe, al massimo `MillisecondiPerTick` (default 1 ms su 16,6 di un tick);
- PNG, panoramica e file scritti da un thread a parte; un riquadro identico al precedente non si riscrive;
- modifiche scoperte dai pacchetti che il server manda ai client (blocchi, aree, liquidi, vernice, mobili),
  con `MillisecondiAttesaModifiche` per raggruppare gli scavi; una rilettura a rotazione
  (`MinutiTraRiletture`) copre il poco che sfugge.

Comandi (permesso `livemap.admin`): `/mappa` stato e costo per tile, `/mappa rigenera` ridisegna tutto.
Per provarla senza pannello: `"SempreAttiva": true` in `tshock/LiveMap.json` e `/reload`.


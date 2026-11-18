using System.Buffers;
using System.Diagnostics;
using Terraria;
using Terraria.ID;
using Terraria.Map;
using TerrariaApi.Server;
using TShockAPI;
using TShockAPI.Hooks;

namespace LiveMap;

/// <summary>
/// Mappa del mondo in tempo reale per il pannello: riquadri PNG aggiornati solo dove il mondo cambia.
///
/// Per non pesare sul server:
///  - lavora solo se qualcuno guarda la mappa (il pannello tocca tshock/map/viewer) o con SempreAttiva;
///  - sul thread di gioco disegna al massimo MillisecondiPerTick ms per tick, una riga di tile alla volta;
///    a server vuoto Terraria ferma l'aggiornamento del mondo (niente GameUpdate): allora disegna un timer,
///    con lo stesso limite, senza rischi perché nessuno sta modificando il mondo;
///  - PNG e file li scrive un thread a parte (MapWriter);
///  - le modifiche si scoprono dai pacchetti che il server manda ai client (NetSendData), senza scansioni;
///    una rilettura lentissima a rotazione copre il resto.
/// </summary>
[ApiVersion(2, 1)]
public class LiveMap : TerrariaPlugin
{
    public override string Name => "LiveMap";
    public override Version Version => new(1, 0, 0);
    public override string Author => "tModManager";
    public override string Description => "Mappa del mondo in tempo reale per il pannello di tModManager.";

    /// <summary>Come le sezioni di Terraria: le dimensioni standard dei mondi ne sono multipli.</summary>
    public const int ChunkWidth = 200, ChunkHeight = 150;

    private static string ConfigPath => Path.Combine(TShock.SavePath, "LiveMap.json");
    private static string MapDir => Path.Combine(TShock.SavePath, "map");

    private Config _config = new();
    private Command? _command;
    private MapWriter? _writer;
    private bool _ready, _active;

    // Stato del disegno. _dirty/_dirtySince/_dirtyCount anche da altri thread (NetSendData): sotto _lock.
    private readonly object _lock = new();
    private int _cols, _rows;
    private bool[] _dirty = [];
    private long[] _dirtySince = [];
    private int _dirtyCount;
    private long[] _lastDrawn = []; // 0 = mai disegnato da questo avvio
    private int _cursor;
    private Job? _job;
    private long _nextActivityCheck, _nextPlayers, _nextRotationCheck;

    // Chi disegna: il thread di gioco (GameUpdate) oppure, a server fermo senza giocatori, il timer
    private readonly object _drawLock = new();
    private Timer? _idleTimer;
    private long _lastGameUpdate;

    // Statistiche per /mappa
    private long _tilesDrawn, _drawTicks, _errors;

    private sealed class Job
    {
        public int Index, X0, Y0, Width, Height, Row;
        public int[] Pixels = [];
    }

    public LiveMap(Main game) : base(game) { }

    public override void Initialize()
    {
        Directory.CreateDirectory(MapDir);
        _config = Config.Load(ConfigPath);

        _command = new Command("livemap.admin", MapCommand, "mappa", "livemap")
        {
            HelpText = "Stato della mappa del pannello. Uso: /mappa [rigenera]",
        };
        Commands.ChatCommands.Add(_command);

        ServerApi.Hooks.GamePostInitialize.Register(this, OnWorldReady);
        ServerApi.Hooks.GameUpdate.Register(this, OnUpdate);
        ServerApi.Hooks.NetSendData.Register(this, OnSendData);
        GeneralHooks.ReloadEvent += OnReload;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            ServerApi.Hooks.GamePostInitialize.Deregister(this, OnWorldReady);
            ServerApi.Hooks.GameUpdate.Deregister(this, OnUpdate);
            ServerApi.Hooks.NetSendData.Deregister(this, OnSendData);
            GeneralHooks.ReloadEvent -= OnReload;
            if (_command != null) Commands.ChatCommands.Remove(_command);
            _ready = false;
            _idleTimer?.Dispose();
            lock (_drawLock)
            {
                if (_job != null) ArrayPool<int>.Shared.Return(_job.Pixels);
                _job = null;
            }
            _writer?.Dispose();
        }
        base.Dispose(disposing);
    }

    private void OnWorldReady(EventArgs args)
    {
        if (!PrepareColors()) return;

        _cols = (Main.maxTilesX + ChunkWidth - 1) / ChunkWidth;
        _rows = (Main.maxTilesY + ChunkHeight - 1) / ChunkHeight;
        lock (_lock)
        {
            _dirty = new bool[_cols * _rows];
            _dirtySince = new long[_cols * _rows];
            _dirtyCount = 0;
        }
        _lastDrawn = new long[_cols * _rows];
        _writer = new MapWriter(MapDir, World(), _cols, _rows, ChunkWidth, ChunkHeight, _config.ScalaPanoramica);
        _ready = true;
        _idleTimer = new Timer(_ => OnIdleTick(), null, 1000, 16);
        TShock.Log.ConsoleInfo($"[LiveMap] Mappa pronta: {_cols}×{_rows} riquadri in {MapDir}" +
                               (_config.SempreAttiva ? " (sempre attiva)" : " (si aggiorna quando il pannello la apre)"));
    }

    /// <summary>
    /// I colori sono quelli della minimappa di Terraria (MapHelper). Sul server dedicato le tabelle potrebbero
    /// non essere inizializzate: in quel caso le prepara il plugin.
    /// </summary>
    private static bool PrepareColors()
    {
        try
        {
            if (MapHelper.colorLookup == null || MapHelper.colorLookup.Length == 0) MapHelper.Initialize();
            var tile = MapHelper.CreateMapTile(Main.spawnTileX, Main.spawnTileY, 255);
            MapHelper.GetMapTileXnaColor(tile, Main.spawnTileX, Main.spawnTileY);
            return true;
        }
        catch (Exception ex)
        {
            TShock.Log.ConsoleError($"[LiveMap] I colori della mappa non sono disponibili su questo server, plugin disattivato: {ex}");
            return false;
        }
    }

    private void OnUpdate(EventArgs args)
    {
        Interlocked.Exchange(ref _lastGameUpdate, Environment.TickCount64);
        lock (_drawLock) Tick();
    }

    /// <summary>
    /// Server senza giocatori: Terraria non chiama più GameUpdate (il mondo è fermo). Se il gioco tace da più di
    /// un secondo, il disegno va avanti qui, 60 volte al secondo come il gioco; appena il gioco riparte, smette.
    /// </summary>
    private void OnIdleTick()
    {
        if (Environment.TickCount64 - Interlocked.Read(ref _lastGameUpdate) < 1000) return;
        if (!Monitor.TryEnter(_drawLock)) return;
        try
        {
            Tick();
        }
        catch (Exception ex)
        {
            TShock.Log.ConsoleError($"[LiveMap] Disegno della mappa non riuscito: {ex.Message}");
        }
        finally
        {
            Monitor.Exit(_drawLock);
        }
    }

    /// <summary>Un passo di lavoro, al massimo MillisecondiPerTick. Sempre sotto _drawLock.</summary>
    private void Tick()
    {
        if (!_ready || _writer == null) return;
        var now = Environment.TickCount64;

        if (now >= _nextActivityCheck)
        {
            _nextActivityCheck = now + 2000;
            _active = _config.SempreAttiva || ViewerRecent();
        }
        if (!_active) return; // le modifiche intanto si segnano lo stesso: alla riapertura si ridisegnano quelle

        if (now >= _nextPlayers)
        {
            _nextPlayers = now + (long)(_config.SecondiGiocatori * 1000);
            _writer.Players(World(), Players());
        }

        var start = Stopwatch.GetTimestamp();
        var budget = (long)(_config.MillisecondiPerTick * Stopwatch.Frequency / 1000);
        while (_writer.Pending < 4) // se il disco resta indietro, si aspetta invece di accumulare
        {
            if (_job == null && !StartJob(now)) break;
            DrawRow(_job!);
            if (_job!.Row == _job.Height) FinishJob(now);
            if (Stopwatch.GetTimestamp() - start >= budget) break;
        }
        _drawTicks += Stopwatch.GetTimestamp() - start;
    }

    private bool ViewerRecent()
    {
        var touched = File.GetLastWriteTimeUtc(Path.Combine(MapDir, "viewer")); // 1601 se manca
        return (DateTime.UtcNow - touched).TotalSeconds <= _config.SecondiSenzaSpettatori;
    }

    /// <summary>Prossimo riquadro: prima quelli modificati (dopo l'attesa), poi la rotazione.</summary>
    private bool StartJob(long now)
    {
        var index = -1;
        lock (_lock)
        {
            if (_dirtyCount > 0)
            {
                for (var i = 0; i < _dirty.Length; i++)
                {
                    if (_dirty[i] && now - _dirtySince[i] >= _config.MillisecondiAttesaModifiche)
                    {
                        index = i;
                        break;
                    }
                }
            }
        }

        if (index < 0 && now >= _nextRotationCheck)
        {
            var rescan = _config.MinutiTraRiletture * 60_000L;
            for (var k = 0; k < _lastDrawn.Length; k++)
            {
                var i = (_cursor + k) % _lastDrawn.Length;
                if (_lastDrawn[i] == 0 || now - _lastDrawn[i] >= rescan)
                {
                    index = i;
                    _cursor = (i + 1) % _lastDrawn.Length;
                    break;
                }
            }
            if (index < 0) _nextRotationCheck = now + 1000;
        }
        if (index < 0) return false;

        // Da qui in poi una nuova modifica lo rimette in coda (verrà ridisegnato di nuovo)
        lock (_lock)
        {
            if (_dirty[index])
            {
                _dirty[index] = false;
                _dirtyCount--;
            }
        }

        var x0 = index % _cols * ChunkWidth;
        var y0 = index / _cols * ChunkHeight;
        var width = Math.Min(ChunkWidth, Main.maxTilesX - x0);
        var height = Math.Min(ChunkHeight, Main.maxTilesY - y0);
        _job = new Job
        {
            Index = index, X0 = x0, Y0 = y0, Width = width, Height = height,
            Pixels = ArrayPool<int>.Shared.Rent(width * height),
        };
        return true;
    }

    private void DrawRow(Job job)
    {
        var y = job.Y0 + job.Row;
        var offset = job.Row * job.Width;
        for (var dx = 0; dx < job.Width; dx++)
        {
            var x = job.X0 + dx;
            int pixel;
            try
            {
                var color = MapHelper.GetMapTileXnaColor(MapHelper.CreateMapTile(x, y, 255), x, y);
                pixel = color.R << 16 | color.G << 8 | color.B;
            }
            catch
            {
                pixel = 0xFF00FF; // tile che Terraria non sa colorare: magenta, si vede subito
                _errors++;
            }
            job.Pixels[offset + dx] = pixel;
        }
        job.Row++;
        _tilesDrawn += job.Width;
    }

    private void FinishJob(long now)
    {
        var job = _job!;
        _job = null;
        _lastDrawn[job.Index] = now;
        _writer!.Chunk(job.Index, job.Pixels, job.Width, job.Height);
    }

    /// <summary>
    /// Ogni modifica al mondo che conta passa da qui, perché il server la deve mandare ai client: quelle dei giocatori
    /// (rimbalzate agli altri) e quelle del gioco (esplosioni, erba, alberi, liquidi). Qui si segna solo il riquadro.
    /// </summary>
    private void OnSendData(SendDataEventArgs e)
    {
        if (!_ready) return;
        switch ((int)e.MsgId)
        {
            case MessageID.TileManipulation:
                MarkAround(e.number2, e.number3, 3);
                break;
            case MessageID.AreaTileChange: // NetMessage.SendTileSquare: x, y, larghezza, altezza
                MarkArea(e.number, (int)e.number2, (int)e.number3, (int)e.number4);
                break;
            case MessageID.LiquidUpdate:
            case MessageID.SyncTilePaintOrCoating:
            case MessageID.SyncWallPaintOrCoating:
                MarkAround(e.number, e.number2, 1);
                break;
            case MessageID.PlaceObject:
            case MessageID.TileEntityPlacement:
                MarkAround(e.number, e.number2, 6); // mobili e statue: fino a qualche tile dall'ancora
                break;
        }
    }

    private void MarkAround(float x, float y, int pad) => MarkArea((int)x - pad, (int)y - pad, pad * 2 + 1, pad * 2 + 1);

    private void MarkArea(int x, int y, int width, int height)
    {
        var x1 = Math.Min(x + Math.Max(width, 1) - 1, Main.maxTilesX - 1);
        var y1 = Math.Min(y + Math.Max(height, 1) - 1, Main.maxTilesY - 1);
        x = Math.Max(x, 0);
        y = Math.Max(y, 0);
        if (x > x1 || y > y1) return;

        var now = Environment.TickCount64;
        lock (_lock)
        {
            for (var cy = y / ChunkHeight; cy <= y1 / ChunkHeight; cy++)
            {
                for (var cx = x / ChunkWidth; cx <= x1 / ChunkWidth; cx++)
                {
                    var i = cy * _cols + cx;
                    if ((uint)i >= (uint)_dirty.Length || _dirty[i]) continue;
                    _dirty[i] = true;
                    _dirtySince[i] = now;
                    _dirtyCount++;
                }
            }
        }
    }

    private static WorldInfo World() => new(
        Main.worldName, Main.worldID, Main.maxTilesX, Main.maxTilesY,
        Main.spawnTileX, Main.spawnTileY, (int)Main.worldSurface, (int)Main.rockLayer);

    private static List<PlayerInfo> Players()
    {
        var list = new List<PlayerInfo>();
        foreach (var player in TShock.Players)
        {
            if (player is not { Active: true } || player.TPlayer == null) continue;
            var p = player.TPlayer;
            list.Add(new PlayerInfo(player.Name, MathF.Round(p.Center.X / 16f, 1), MathF.Round(p.Center.Y / 16f, 1),
                p.team, p.statLife, p.statLifeMax2, p.dead));
        }
        return list;
    }

    private void MapCommand(CommandArgs args)
    {
        var player = args.Player;
        if (!_ready || _writer == null)
        {
            player.SendErrorMessage("[LiveMap] La mappa non è attiva (mondo non ancora caricato o colori non disponibili).");
            return;
        }

        if (args.Parameters.Count > 0 && args.Parameters[0].Equals("rigenera", StringComparison.OrdinalIgnoreCase))
        {
            lock (_drawLock) Array.Clear(_lastDrawn);
            _nextRotationCheck = 0;
            _writer.ForgetHashes();
            player.SendSuccessMessage("[LiveMap] La mappa verrà ridisegnata da capo.");
            return;
        }

        int dirty;
        lock (_lock) dirty = _dirtyCount;
        var state = _config.SempreAttiva ? "attiva (SempreAttiva)" : _active ? "attiva (il pannello la sta guardando)" : "in pausa (nessuno la guarda)";
        player.SendInfoMessage($"[LiveMap] Mappa {state}.");
        player.SendInfoMessage($"Riquadri disegnati da questo avvio: {_writer.Drawn}/{_writer.Total}; modificati in attesa: {dirty}.");
        if (_tilesDrawn > 0)
        {
            var micro = _drawTicks * 1_000_000.0 / Stopwatch.Frequency / _tilesDrawn;
            player.SendInfoMessage($"Costo: {micro:0.00} µs per tile, {_tilesDrawn:N0} tile disegnate" +
                                   (_errors > 0 ? $", {_errors} non colorabili" : "") + ".");
        }
    }

    private void OnReload(ReloadEventArgs args)
    {
        _config = Config.Load(ConfigPath);
        _nextActivityCheck = 0;
        args.Player.SendSuccessMessage("[LiveMap] Configurazione ricaricata (ScalaPanoramica vale dal prossimo riavvio).");
    }
}

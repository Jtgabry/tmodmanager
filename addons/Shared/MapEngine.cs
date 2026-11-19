using System.Buffers;
using System.Diagnostics;

namespace TmmLiveMap;

/// <summary>
/// Il disegno della mappa, uguale per il plugin TShock e per la mod tModLoader: l'host dà i colori delle tile,
/// il mondo e i giocatori, e chiama OnGameUpdate a ogni tick e OnSendData per i pacchetti mandati ai client.
///
/// Per non pesare sul server:
///  - lavora solo se qualcuno guarda la mappa (il pannello tocca il file viewer) o con SempreAttiva;
///  - sul thread di gioco disegna al massimo MillisecondiPerTick ms per tick, una riga di tile alla volta;
///    a server vuoto Terraria ferma l'aggiornamento del mondo (niente tick): allora disegna un timer,
///    con lo stesso limite, senza rischi perché nessuno sta modificando il mondo;
///  - PNG e file li scrive un thread a parte (MapWriter);
///  - le modifiche si scoprono dai pacchetti che il server manda ai client, senza scansioni;
///    una rilettura lentissima a rotazione copre il resto.
/// </summary>
public sealed class MapEngine : IDisposable
{
    /// <summary>Come le sezioni di Terraria: le dimensioni standard dei mondi ne sono multipli.</summary>
    public const int ChunkWidth = 200, ChunkHeight = 150;

    private readonly string _dir;
    private readonly int _width, _height;
    private readonly Func<int, int, int> _pixel;
    private readonly Func<WorldInfo> _world;
    private readonly Func<List<PlayerInfo>> _players;
    private readonly MapWriter _writer;
    private volatile Config _config;
    private volatile bool _disposed;
    private bool _active;

    // _dirty/_dirtySince/_dirtyCount anche da altri thread (pacchetti di rete): sotto _lock
    private readonly object _lock = new();
    private readonly int _cols, _rows;
    private readonly bool[] _dirty;
    private readonly long[] _dirtySince;
    private int _dirtyCount;
    private readonly long[] _lastDrawn; // 0 = mai disegnato da questo avvio
    private int _cursor;
    private Job? _job;
    private long _nextActivityCheck, _nextPlayers, _nextRotationCheck;

    // Chi disegna: il thread di gioco (OnGameUpdate) oppure, a server fermo senza giocatori, il timer
    private readonly object _drawLock = new();
    private readonly Timer _idleTimer;
    private long _lastGameUpdate;

    // Statistiche per il comando /mappa
    private long _tilesDrawn, _drawTicks, _errors;

    private sealed class Job
    {
        public int Index, X0, Y0, Width, Height, Row;
        public int[] Pixels = [];
    }

    /// <param name="pixel">Colore 0xRRGGBB della tile (x, y) come nella minimappa; un'eccezione la fa magenta.</param>
    public MapEngine(string dir, Config config, int width, int height, Func<int, int, int> pixel, Func<WorldInfo> world, Func<List<PlayerInfo>> players)
    {
        _dir = dir;
        _config = config;
        _width = width;
        _height = height;
        _pixel = pixel;
        _world = world;
        _players = players;
        _cols = (width + ChunkWidth - 1) / ChunkWidth;
        _rows = (height + ChunkHeight - 1) / ChunkHeight;
        _dirty = new bool[_cols * _rows];
        _dirtySince = new long[_cols * _rows];
        _lastDrawn = new long[_cols * _rows];
        Directory.CreateDirectory(dir);
        _writer = new MapWriter(dir, world(), _cols, _rows, ChunkWidth, ChunkHeight, config.ScalaPanoramica);
        _idleTimer = new Timer(_ => OnIdleTick(), null, 1000, 16);
    }

    public int Cols => _cols;
    public int Rows => _rows;

    /// <summary>Nuova configurazione (ScalaPanoramica vale dal prossimo riavvio).</summary>
    public Config Config
    {
        get => _config;
        set
        {
            _config = value;
            _nextActivityCheck = 0;
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _idleTimer.Dispose();
        lock (_drawLock)
        {
            if (_job != null) ArrayPool<int>.Shared.Return(_job.Pixels);
            _job = null;
        }
        _writer.Dispose();
    }

    /// <summary>A ogni tick del gioco, dal thread di gioco.</summary>
    public void OnGameUpdate()
    {
        Interlocked.Exchange(ref _lastGameUpdate, Environment.TickCount64);
        lock (_drawLock) Tick();
    }

    /// <summary>
    /// Server senza giocatori: Terraria non aggiorna più il mondo. Se il gioco tace da più di un secondo, il disegno
    /// va avanti qui, 60 volte al secondo come il gioco; appena il gioco riparte, smette.
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
            Log.Error($"Disegno della mappa non riuscito: {ex.Message}");
        }
        finally
        {
            Monitor.Exit(_drawLock);
        }
    }

    /// <summary>Un passo di lavoro, al massimo MillisecondiPerTick. Sempre sotto _drawLock.</summary>
    private void Tick()
    {
        if (_disposed) return;
        var config = _config;
        var now = Environment.TickCount64;

        if (now >= _nextActivityCheck)
        {
            _nextActivityCheck = now + 2000;
            _active = config.SempreAttiva || ViewerRecent(config);
        }
        if (!_active) return; // le modifiche intanto si segnano lo stesso: alla riapertura si ridisegnano quelle

        if (now >= _nextPlayers)
        {
            _nextPlayers = now + (long)(config.SecondiGiocatori * 1000);
            _writer.Players(_world(), _players());
        }

        var start = Stopwatch.GetTimestamp();
        var budget = (long)(config.MillisecondiPerTick * Stopwatch.Frequency / 1000);
        while (_writer.Pending < 4) // se il disco resta indietro, si aspetta invece di accumulare
        {
            if (_job == null && !StartJob(now, config)) break;
            DrawRow(_job!);
            if (_job!.Row == _job.Height) FinishJob(now);
            if (Stopwatch.GetTimestamp() - start >= budget) break;
        }
        _drawTicks += Stopwatch.GetTimestamp() - start;
    }

    private bool ViewerRecent(Config config)
    {
        var touched = File.GetLastWriteTimeUtc(Path.Combine(_dir, "viewer")); // 1601 se manca
        return (DateTime.UtcNow - touched).TotalSeconds <= config.SecondiSenzaSpettatori;
    }

    /// <summary>Prossimo riquadro: prima quelli modificati (dopo l'attesa), poi la rotazione.</summary>
    private bool StartJob(long now, Config config)
    {
        var index = -1;
        lock (_lock)
        {
            if (_dirtyCount > 0)
            {
                for (var i = 0; i < _dirty.Length; i++)
                {
                    if (_dirty[i] && now - _dirtySince[i] >= config.MillisecondiAttesaModifiche)
                    {
                        index = i;
                        break;
                    }
                }
            }
        }

        if (index < 0 && now >= _nextRotationCheck)
        {
            var rescan = config.MinutiTraRiletture * 60_000L;
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
        var width = Math.Min(ChunkWidth, _width - x0);
        var height = Math.Min(ChunkHeight, _height - y0);
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
            int pixel;
            try
            {
                pixel = _pixel(job.X0 + dx, y);
            }
            catch
            {
                pixel = 0xFF00FF; // tile che il gioco non sa colorare: magenta, si vede subito
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
        _writer.Chunk(job.Index, job.Pixels, job.Width, job.Height);
    }

    /// <summary>
    /// Ogni modifica al mondo che conta passa dai pacchetti che il server manda ai client: quelle dei giocatori
    /// (rimbalzate agli altri) e quelle del gioco (esplosioni, erba, alberi, liquidi). Qui si segna solo il riquadro.
    /// </summary>
    public void OnSendData(int msgId, int number, float number2, float number3, float number4)
    {
        if (_disposed) return;
        switch (msgId)
        {
            case 17: // MessageID.TileManipulation (i numeri, non i nomi: cambiano tra le versioni di Terraria)
                MarkAround(number2, number3, 3);
                break;
            case 20: // TileSquare / AreaTileChange (NetMessage.SendTileSquare): x, y, larghezza, altezza
                MarkArea(number, (int)number2, (int)number3, (int)number4);
                break;
            case 48: // LiquidUpdate
            case 63: // PaintTile / SyncTilePaintOrCoating
            case 64: // PaintWall / SyncWallPaintOrCoating
                MarkAround(number, number2, 1);
                break;
            case 79: // PlaceObject
            case 87: // TileEntityPlacement
                MarkAround(number, number2, 6); // mobili e statue: fino a qualche tile dall'ancora
                break;
        }
    }

    private void MarkAround(float x, float y, int pad) => MarkArea((int)x - pad, (int)y - pad, pad * 2 + 1, pad * 2 + 1);

    public void MarkArea(int x, int y, int width, int height)
    {
        var x1 = Math.Min(x + Math.Max(width, 1) - 1, _width - 1);
        var y1 = Math.Min(y + Math.Max(height, 1) - 1, _height - 1);
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

    /// <summary>Ridisegna tutto da capo (comando "/mappa rigenera").</summary>
    public void Regenerate()
    {
        lock (_drawLock) Array.Clear(_lastDrawn);
        _nextRotationCheck = 0;
        _writer.ForgetHashes();
    }

    /// <summary>Righe di stato per il comando "/mappa".</summary>
    public List<string> Status()
    {
        int dirty;
        lock (_lock) dirty = _dirtyCount;
        var config = _config;
        var state = config.SempreAttiva ? "attiva (SempreAttiva)" : _active ? "attiva (il pannello la sta guardando)" : "in pausa (nessuno la guarda)";
        var lines = new List<string>
        {
            $"Mappa {state}.",
            $"Riquadri disegnati da questo avvio: {_writer.Drawn}/{_writer.Total}; modificati in attesa: {dirty}.",
        };
        if (_tilesDrawn > 0)
        {
            var micro = _drawTicks * 1_000_000.0 / Stopwatch.Frequency / _tilesDrawn;
            lines.Add($"Costo: {micro:0.00} µs per tile, {_tilesDrawn:N0} tile disegnate" + (_errors > 0 ? $", {_errors} non colorabili" : "") + ".");
        }
        return lines;
    }
}

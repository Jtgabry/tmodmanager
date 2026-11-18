using System.Buffers;
using System.Text.Json;
using System.Threading.Channels;
using TShockAPI;

namespace LiveMap;

public sealed record WorldInfo(string Name, int Id, int Width, int Height, int SpawnX, int SpawnY, int Surface, int Rock);

public sealed record PlayerInfo(string Name, float X, float Y, int Team, int Life, int LifeMax, bool Dead);

/// <summary>
/// Thread di scrittura: codifica i PNG, tiene la panoramica e scrive manifest e giocatori.
/// Tutto il suo stato è toccato solo dal suo thread (le richieste arrivano in coda), così il thread di gioco
/// non aspetta mai il disco.
///
/// Cartella (tshock/map/):
///   manifest.json          mondo, griglia dei riquadri e loro versioni
///   chunks/{cx}_{cy}.png   riquadri da 200×150 tile, un pixel per tile
///   overview.png           mondo intero ridotto (scritta solo dopo il primo giro completo)
///   players.json           posizioni dei giocatori, in tile
///   viewer                 toccato dal pannello finché la mappa è aperta: senza, il plugin non lavora
/// </summary>
public sealed class MapWriter : IDisposable
{
    public const int Format = 1;
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private readonly Channel<Action> _queue = Channel.CreateUnbounded<Action>(new UnboundedChannelOptions { SingleReader = true });
    private readonly Task _loop;
    private readonly Timer _flushTimer;
    private int _pending;

    private readonly string _dir, _chunksDir;
    private readonly int _cols, _rows, _chunkWidth, _chunkHeight, _scale;
    private WorldInfo _world;
    private readonly long[] _versions;
    private readonly ulong[] _hashes;
    private readonly bool[] _drawn;
    private int _drawnCount;

    private readonly int[] _overview;
    private readonly int _overviewWidth, _overviewHeight;
    private long _overviewVersion, _overviewWrittenAt;
    private bool _overviewDirty, _manifestDirty;
    private string? _lastPlayers;

    /// <summary>Riquadri in coda di scrittura: il thread di gioco smette di disegnarne se il disco resta indietro.</summary>
    public int Pending => Volatile.Read(ref _pending);
    /// <summary>Riquadri disegnati da quando il server è partito.</summary>
    public int Drawn => Volatile.Read(ref _drawnCount);
    public int Total => _cols * _rows;

    public string Dir => _dir;

    public MapWriter(string dir, WorldInfo world, int cols, int rows, int chunkWidth, int chunkHeight, int scale)
    {
        _dir = dir;
        _chunksDir = Path.Combine(dir, "chunks");
        _world = world;
        (_cols, _rows, _chunkWidth, _chunkHeight, _scale) = (cols, rows, chunkWidth, chunkHeight, scale);
        _versions = new long[cols * rows];
        _hashes = new ulong[cols * rows];
        _drawn = new bool[cols * rows];
        _overviewWidth = (world.Width + scale - 1) / scale;
        _overviewHeight = (world.Height + scale - 1) / scale;
        _overview = new int[_overviewWidth * _overviewHeight];

        Enqueue(Restore, counted: false);
        _loop = Task.Run(Run);
        _flushTimer = new Timer(_ => Enqueue(Flush, counted: false), null, 2000, 2000);
    }

    /// <summary>Consegna un riquadro disegnato; <paramref name="pixels"/> viene da ArrayPool e passa a questo thread.</summary>
    public void Chunk(int index, int[] pixels, int width, int height) =>
        Enqueue(() =>
        {
            try { WriteChunk(index, pixels, width, height); }
            finally { ArrayPool<int>.Shared.Return(pixels); }
        }, counted: true);

    public void Players(WorldInfo world, List<PlayerInfo> players) => Enqueue(() => WritePlayers(world, players), counted: false);

    /// <summary>Al prossimo disegno ogni riquadro viene riscritto anche se non è cambiato.</summary>
    public void ForgetHashes() => Enqueue(() => Array.Clear(_hashes), counted: false);

    public void Dispose()
    {
        _flushTimer.Dispose();
        Enqueue(() => { _overviewWrittenAt = 0; Flush(); }, counted: false);
        _queue.Writer.TryComplete();
        _loop.Wait(TimeSpan.FromSeconds(5));
    }

    private void Enqueue(Action action, bool counted)
    {
        if (counted) Interlocked.Increment(ref _pending);
        var queued = _queue.Writer.TryWrite(() =>
        {
            try { action(); }
            catch (Exception ex) { TShock.Log.ConsoleError($"[LiveMap] Scrittura della mappa non riuscita: {ex.Message}"); }
            finally { if (counted) Interlocked.Decrement(ref _pending); }
        });
        if (!queued && counted) Interlocked.Decrement(ref _pending);
    }

    private async Task Run()
    {
        await foreach (var action in _queue.Reader.ReadAllAsync()) action();
    }

    private string ManifestPath => Path.Combine(_dir, "manifest.json");
    private string ChunkPath(int index) => Path.Combine(_chunksDir, $"{index % _cols}_{index / _cols}.png");

    /// <summary>Riprende versioni e hash dell'avvio precedente se il mondo è lo stesso, altrimenti riparte pulito.</summary>
    private void Restore()
    {
        Directory.CreateDirectory(_chunksDir);
        try
        {
            if (File.Exists(ManifestPath))
            {
                var old = JsonSerializer.Deserialize<Manifest>(File.ReadAllText(ManifestPath), Json);
                if (old is not null && old.Format == Format && old.World.Id == _world.Id && old.World.Name == _world.Name
                    && old.World.Width == _world.Width && old.World.Height == _world.Height
                    && old.Cols == _cols && old.Rows == _rows && old.ChunkWidth == _chunkWidth && old.ChunkHeight == _chunkHeight
                    && old.Chunks.Length == _versions.Length && old.Hashes.Length == _hashes.Length)
                {
                    Array.Copy(old.Chunks, _versions, _versions.Length);
                    for (var i = 0; i < _hashes.Length; i++) _hashes[i] = Convert.ToUInt64(old.Hashes[i], 16);
                    if (old.Overview.Scale == _scale) _overviewVersion = old.Overview.Version;
                    return;
                }
            }
        }
        catch (Exception ex)
        {
            TShock.Log.ConsoleWarn($"[LiveMap] manifest.json illeggibile, rigenero la mappa: {ex.Message}");
        }

        // Mondo diverso (o primo avvio): via i riquadri vecchi
        foreach (var file in Directory.EnumerateFiles(_chunksDir, "*.png")) File.Delete(file);
        File.Delete(Path.Combine(_dir, "overview.png"));
        _manifestDirty = true;
    }

    private void WriteChunk(int index, int[] pixels, int width, int height)
    {
        var hash = Hash(pixels, width * height);
        var path = ChunkPath(index);
        if (hash != _hashes[index] || !File.Exists(path))
        {
            Png.Write(path, pixels, width, height, width);
            _versions[index] = NextVersion(_versions[index]);
            _hashes[index] = hash;
            _manifestDirty = true;
        }
        if (!_drawn[index])
        {
            _drawn[index] = true;
            Interlocked.Increment(ref _drawnCount);
            _manifestDirty = true;
        }

        // Panoramica: un campione ogni _scale tile, sulle coordinate globali (i riquadri non sono multipli della scala)
        int x0 = index % _cols * _chunkWidth, y0 = index / _cols * _chunkHeight;
        int firstY = (y0 + _scale - 1) / _scale * _scale, firstX = (x0 + _scale - 1) / _scale * _scale;
        for (var gy = firstY; gy < y0 + height; gy += _scale)
        {
            var row = gy / _scale * _overviewWidth;
            for (var gx = firstX; gx < x0 + width; gx += _scale)
            {
                var p = pixels[(gy - y0) * width + (gx - x0)];
                ref var o = ref _overview[row + gx / _scale];
                if (o == p) continue;
                o = p;
                _overviewDirty = true;
            }
        }
    }

    private void WritePlayers(WorldInfo world, List<PlayerInfo> players)
    {
        if (world.SpawnX != _world.SpawnX || world.SpawnY != _world.SpawnY) _manifestDirty = true;
        _world = world;

        var json = JsonSerializer.Serialize(new { players }, Json);
        if (json == _lastPlayers) return;
        _lastPlayers = json;
        WriteAtomic(Path.Combine(_dir, "players.json"), json);
    }

    private void Flush()
    {
        // La panoramica aspetta il primo giro completo (prima avrebbe zone nere) e al massimo una ogni 10 s
        var now = Environment.TickCount64;
        if (_overviewDirty && _drawnCount == Total && now - _overviewWrittenAt >= 10_000)
        {
            Png.Write(Path.Combine(_dir, "overview.png"), _overview, _overviewWidth, _overviewHeight, _overviewWidth);
            _overviewVersion = NextVersion(_overviewVersion);
            _overviewWrittenAt = now;
            _overviewDirty = false;
            _manifestDirty = true;
        }
        if (!_manifestDirty) return;
        _manifestDirty = false;

        var manifest = new Manifest
        {
            Format = Format,
            World = _world,
            ChunkWidth = _chunkWidth,
            ChunkHeight = _chunkHeight,
            Cols = _cols,
            Rows = _rows,
            Chunks = _versions,
            Hashes = _hashes.Select(h => h.ToString("x16")).ToArray(),
            Overview = new OverviewInfo(_scale, _overviewWidth, _overviewHeight, _overviewVersion),
            Progress = new ProgressInfo(_drawnCount, Total),
        };
        WriteAtomic(ManifestPath, JsonSerializer.Serialize(manifest, Json));
    }

    /// <summary>Versione = istante di scrittura in ms, sempre crescente: il pannello la usa per scavalcare la cache.</summary>
    private static long NextVersion(long previous) => Math.Max(previous + 1, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

    private static ulong Hash(int[] pixels, int count)
    {
        var hash = 14695981039346656037UL; // FNV-1a
        for (var i = 0; i < count; i++) hash = (hash ^ (uint)pixels[i]) * 1099511628211UL;
        return hash == 0 ? 1 : hash; // 0 = "mai scritto"
    }

    private static void WriteAtomic(string path, string content)
    {
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, content);
        File.Move(tmp, path, overwrite: true);
    }

    private sealed class Manifest
    {
        public int Format { get; set; }
        public WorldInfo World { get; set; } = null!;
        public int ChunkWidth { get; set; }
        public int ChunkHeight { get; set; }
        public int Cols { get; set; }
        public int Rows { get; set; }
        /// <summary>Versione di ogni riquadro, riga per riga (indice = cy * cols + cx); 0 = non ancora disegnato.</summary>
        public long[] Chunks { get; set; } = [];
        public string[] Hashes { get; set; } = [];
        public OverviewInfo Overview { get; set; } = null!;
        public ProgressInfo Progress { get; set; } = null!;
    }

    private sealed record OverviewInfo(int Scale, int Width, int Height, long Version);

    private sealed record ProgressInfo(int Drawn, int Total);
}

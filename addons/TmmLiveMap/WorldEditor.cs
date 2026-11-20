using System.Text.Json;
using System.Text.Json.Serialization;
using Terraria;
using Terraria.ID;
using Terraria.ModLoader;

namespace TmmLiveMap;

/// <summary>
/// Editor del mondo dal pannello, a server acceso: piazza e rimuove blocchi e muri come farebbe un giocatore, e li
/// manda ai client connessi (li vedono subito). Prototipo: solo la mod tModLoader.
///
/// Canale con il pannello, nella cartella di LiveMap (accanto a manifest.json):
///   editor/inbox/{id}.json   comandi scritti dall'agent (prima .tmp, poi rinominati: mai letti a metà);
///   editor/outbox/{id}.json  esito, scritto qui; l'agent lo legge e lo cancella;
///   editor/catalog.json      blocchi e muri che si possono piazzare (nomi, mod), a ogni caricamento del mondo;
///   editor/alive             toccato ogni 2 secondi: il pannello sa che l'editor risponde.
///
/// Il mondo si tocca solo dal thread di gioco (PostUpdateEverything). A server vuoto Terraria non aggiorna il mondo
/// e quel thread tace: allora i comandi li esegue il timer, come fa MapEngine per il disegno (nessun altro sta
/// modificando il mondo). I comandi più vecchi di <see cref="MaxAgeMs"/> si scartano: l'agent ha già risposto
/// "nessuna risposta" e non devono applicarsi più tardi (per esempio al riavvio successivo).
/// </summary>
public sealed class WorldEditor : IDisposable
{
    public const int Format = 1;
    private const long MaxAgeMs = 10_000;
    /// <summary>Operazioni per comando: un tratto di pennello, un rettangolo piccolo.</summary>
    public const int MaxOps = 4096;
    /// <summary>Mobili e oggetti di più tile: quanto oltre le tile toccate può cambiare il mondo (e va mandato ai client).</summary>
    private const int Margin = 6;
    /// <summary>Lato dei quadrati di tile mandati ai client (NetMessage.SendTileSquare: un pacchetto ciascuno).</summary>
    private const int SquareSize = 32;

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly string _dir, _inbox, _outbox;
    private readonly Action<int, int, int, int>? _changed;
    private readonly object _lock = new();
    private readonly Timer _timer;
    private long _lastGameUpdate, _nextPoll, _nextAlive;
    private volatile bool _disposed;

    /// <param name="changed">Area cambiata (x, y, larghezza, altezza), per ridisegnare la mappa.</param>
    public WorldEditor(string mapDir, Action<int, int, int, int>? changed)
    {
        _dir = Path.Combine(mapDir, "editor");
        _inbox = Path.Combine(_dir, "inbox");
        _outbox = Path.Combine(_dir, "outbox");
        _changed = changed;
        Directory.CreateDirectory(_inbox);
        Directory.CreateDirectory(_outbox);
        // Comandi rimasti da un avvio precedente: troppo vecchi, e l'agent non aspetta più la risposta
        foreach (var file in Directory.EnumerateFiles(_inbox).Concat(Directory.EnumerateFiles(_outbox))) TryDelete(file);
        WriteCatalog();
        _timer = new Timer(_ => OnTimer(), null, 100, 100);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _timer.Dispose();
        TryDelete(Path.Combine(_dir, "alive"));
    }

    /// <summary>A ogni tick del gioco, dal thread di gioco.</summary>
    public void OnGameUpdate()
    {
        Interlocked.Exchange(ref _lastGameUpdate, Environment.TickCount64);
        lock (_lock) Poll();
    }

    private void OnTimer()
    {
        if (_disposed) return;
        var now = Environment.TickCount64;
        if (now >= _nextAlive)
        {
            _nextAlive = now + 2000;
            try
            {
                File.WriteAllText(Path.Combine(_dir, "alive"), $"{Format}\n");
            }
            catch (Exception ex)
            {
                Log.Warn($"Editor: alive non scritto: {ex.Message}");
            }
        }
        // Il gioco gira: ci pensa il suo thread
        if (now - Interlocked.Read(ref _lastGameUpdate) < 1000) return;
        if (!Monitor.TryEnter(_lock)) return;
        try
        {
            Poll();
        }
        finally
        {
            Monitor.Exit(_lock);
        }
    }

    /// <summary>Esegue i comandi arrivati (al massimo 10 volte al secondo si guarda la cartella). Sotto _lock.</summary>
    private void Poll()
    {
        if (_disposed) return;
        var now = Environment.TickCount64;
        if (now < _nextPoll) return;
        _nextPoll = now + 100;

        string[] files;
        try
        {
            files = Directory.GetFiles(_inbox, "*.json");
        }
        catch (Exception)
        {
            return;
        }
        foreach (var file in files.Order())
        {
            var id = Path.GetFileNameWithoutExtension(file);
            Result result;
            try
            {
                var command = JsonSerializer.Deserialize<Command>(File.ReadAllText(file), Json) ?? throw new InvalidDataException("comando vuoto");
                TryDelete(file);
                var age = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - command.CreatedAt;
                if (age > MaxAgeMs) continue; // l'agent non aspetta più: non si applica
                result = Execute(command);
            }
            catch (Exception ex)
            {
                TryDelete(file);
                result = new Result { Error = ex.Message };
                Log.Warn($"Editor: comando {id} non eseguito: {ex.Message}");
            }
            try
            {
                var tmp = Path.Combine(_outbox, $"{id}.tmp");
                File.WriteAllText(tmp, JsonSerializer.Serialize(result, Json));
                File.Move(tmp, Path.Combine(_outbox, $"{id}.json"), overwrite: true);
            }
            catch (Exception ex)
            {
                Log.Warn($"Editor: esito di {id} non scritto: {ex.Message}");
            }
        }
    }

    private Result Execute(Command command)
    {
        var ops = command.Ops ?? [];
        if (ops.Count > MaxOps) throw new InvalidDataException($"troppe operazioni ({ops.Count}, massimo {MaxOps})");

        var result = new Result();
        int x0 = int.MaxValue, y0 = int.MaxValue, x1 = int.MinValue, y1 = int.MinValue;
        for (var i = 0; i < ops.Count; i++)
        {
            var op = ops[i];
            string? failure;
            try
            {
                failure = Apply(op);
            }
            catch (Exception ex)
            {
                failure = $"errore: {ex.Message}";
            }
            if (failure == null)
            {
                result.Applied++;
                x0 = Math.Min(x0, op.X);
                y0 = Math.Min(y0, op.Y);
                x1 = Math.Max(x1, op.X);
                y1 = Math.Max(y1, op.Y);
            }
            else
            {
                result.Failed++;
                if (result.Failures.Count < 20) result.Failures.Add(new Failure(i, op.X, op.Y, failure));
            }
        }
        if (result.Applied > 0) Sync(x0 - Margin, y0 - Margin, x1 + Margin, y1 + Margin);
        return result;
    }

    /// <summary>Un'operazione. Restituisce null se riuscita, altrimenti il motivo.</summary>
    private static string? Apply(EditOp op)
    {
        // Bordi: il gioco non lascia toccare le ultime tile del mondo
        if (op.X < 10 || op.Y < 10 || op.X >= Main.maxTilesX - 10 || op.Y >= Main.maxTilesY - 10) return "fuori dal mondo";
        var tile = Main.tile[op.X, op.Y];
        switch (op.Op)
        {
            case "place-tile":
            {
                if (op.Type is not { } type || type < 0 || type >= TileLoader.TileCount) return "tipo di blocco non valido";
                if (tile.HasTile)
                {
                    if (tile.TileType == type) return null;
                    // Un blocco al posto di un altro (come il cambio di blocco col piccone): solo tra blocchi normali
                    if (Main.tileFrameImportant[tile.TileType] || Main.tileFrameImportant[type]) return "occupata";
                    return WorldGen.ReplaceTile(op.X, op.Y, (ushort)type, op.Style) ? null : "non sostituibile";
                }
                WorldGen.PlaceTile(op.X, op.Y, type, mute: true, forced: true, plr: -1, style: op.Style);
                var placed = Main.tile[op.X, op.Y];
                // Mobili: l'ancora può non essere la tile indicata, basta che l'oggetto ci sia
                return placed.HasTile && placed.TileType == type ? null : "non piazzabile qui";
            }
            case "kill-tile":
            {
                if (!tile.HasTile) return null;
                WorldGen.KillTile(op.X, op.Y, fail: false, effectOnly: false, noItem: true);
                // Le casse con degli oggetti dentro non si rompono (come nel gioco)
                return Main.tile[op.X, op.Y].HasTile ? "non rimovibile (cassa piena?)" : null;
            }
            case "place-wall":
            {
                if (op.Type is not { } type || type <= 0 || type >= WallLoader.WallCount) return "tipo di muro non valido";
                if (tile.WallType == type) return null;
                if (tile.WallType != 0) return WorldGen.ReplaceWall(op.X, op.Y, (ushort)type) ? null : "non sostituibile";
                WorldGen.PlaceWall(op.X, op.Y, type, mute: true);
                return Main.tile[op.X, op.Y].WallType == type ? null : "non piazzabile qui";
            }
            case "kill-wall":
            {
                if (tile.WallType == 0) return null;
                // Non WorldGen.KillWall: lascerebbe cadere il muro come oggetto. Come lui, poi si ricalcolano i bordi
                tile.WallType = 0;
                tile.WallColor = 0;
                tile.IsWallFullbright = false;
                tile.IsWallInvisible = false;
                WorldGen.SquareWallFrame(op.X, op.Y);
                return null;
            }
            default:
                return $"operazione sconosciuta: {op.Op}";
        }
    }

    /// <summary>Manda l'area cambiata ai client (a quadrati, un pacchetto ciascuno) e la segna da ridisegnare.</summary>
    private void Sync(int x0, int y0, int x1, int y1)
    {
        x0 = Math.Max(x0, 0);
        y0 = Math.Max(y0, 0);
        x1 = Math.Min(x1, Main.maxTilesX - 1);
        y1 = Math.Min(y1, Main.maxTilesY - 1);
        if (Main.netMode == NetmodeID.Server)
        {
            for (var y = y0; y <= y1; y += SquareSize)
                for (var x = x0; x <= x1; x += SquareSize)
                    NetMessage.SendTileSquare(-1, x, y, Math.Min(SquareSize, x1 - x + 1), Math.Min(SquareSize, y1 - y + 1));
        }
        _changed?.Invoke(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    }

    /// <summary>Blocchi e muri che si possono scegliere nel pannello (nome, mod, se è un oggetto di più tile).</summary>
    private void WriteCatalog()
    {
        var catalog = new Catalog();
        for (var type = 0; type < TileLoader.TileCount; type++)
        {
            var mod = TileLoader.GetTile(type);
            var name = mod?.Name ?? (TileID.Search.TryGetName(type, out var n) ? n : null);
            if (name == null) continue;
            catalog.Tiles.Add(new CatalogEntry(type, name, mod?.Mod.Name, Main.tileFrameImportant[type] ? true : null));
        }
        for (var type = 1; type < WallLoader.WallCount; type++)
        {
            var mod = WallLoader.GetWall(type);
            var name = mod?.Name ?? (WallID.Search.TryGetName(type, out var n) ? n : null);
            if (name == null) continue;
            catalog.Walls.Add(new CatalogEntry(type, name, mod?.Mod.Name, null));
        }
        try
        {
            var tmp = Path.Combine(_dir, "catalog.tmp");
            File.WriteAllText(tmp, JsonSerializer.Serialize(catalog, Json));
            File.Move(tmp, Path.Combine(_dir, "catalog.json"), overwrite: true);
        }
        catch (Exception ex)
        {
            Log.Warn($"Editor: catalogo non scritto: {ex.Message}");
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception)
        {
            // Già cancellato o non accessibile: non conta
        }
    }

    private sealed class Command
    {
        /// <summary>Quando l'agent l'ha scritto (ms dal 1970).</summary>
        public long CreatedAt { get; set; }
        public List<EditOp>? Ops { get; set; }
    }

    private sealed class EditOp
    {
        /// <summary>place-tile, kill-tile, place-wall, kill-wall.</summary>
        public string Op { get; set; } = "";
        public int X { get; set; }
        public int Y { get; set; }
        public int? Type { get; set; }
        public int Style { get; set; }
    }

    private sealed class Result
    {
        public int Applied { get; set; }
        public int Failed { get; set; }
        public List<Failure> Failures { get; set; } = [];
        public string? Error { get; set; }
    }

    private sealed record Failure(int Index, int X, int Y, string Reason);

    private sealed class Catalog
    {
        public int Format { get; set; } = WorldEditor.Format;
        public List<CatalogEntry> Tiles { get; set; } = [];
        public List<CatalogEntry> Walls { get; set; } = [];
    }

    private sealed record CatalogEntry(int Type, string Name, string? Mod, bool? Object);
}

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
///   editor/world.json        settaggi del mondo (ora, meteo, eventi, boss…, vedi WorldSettings), ogni 2 secondi;
///   editor/alive             toccato ogni 2 secondi: il pannello sa che l'editor risponde.
/// Un comando ha "ops" (blocchi e muri), "settings" (WorldSettings.Changes) oppure "undo" (l'id di un comando "ops"
/// da annullare, vedi EditHistory). L'esito di un comando "ops" che ha cambiato qualcosa ha "undoId".
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
    /// <summary>Esito di <see cref="Apply"/> quando la tile era già così: né riuscita né fallita.</summary>
    private const string Unchanged = "";
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
    private readonly EditHistory _history = new();
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
        TryDelete(Path.Combine(_dir, "world.json"));
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
                // Lettura da questo thread: valori semplici, al massimo vecchi di un tick
                var tmp = Path.Combine(_dir, "world.tmp");
                File.WriteAllText(tmp, JsonSerializer.Serialize(WorldSettings.Read(), Json));
                File.Move(tmp, Path.Combine(_dir, "world.json"), overwrite: true);
                File.WriteAllText(Path.Combine(_dir, "alive"), $"{Format}\n");
            }
            catch (Exception ex)
            {
                Log.Warn(Text.T($"Editor: alive not written: {ex.Message}", $"Editor: alive non scritto: {ex.Message}"));
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
                var command = JsonSerializer.Deserialize<Command>(File.ReadAllText(file), Json) ?? throw new InvalidDataException("empty command");
                TryDelete(file);
                var age = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - command.CreatedAt;
                if (age > MaxAgeMs) continue; // l'agent non aspetta più: non si applica
                result = Execute(command, id);
            }
            catch (Exception ex)
            {
                TryDelete(file);
                result = new Result { Error = ex.Message };
                Log.Warn(Text.T($"Editor: command {id} not run: {ex.Message}", $"Editor: comando {id} non eseguito: {ex.Message}"));
            }
            try
            {
                var tmp = Path.Combine(_outbox, $"{id}.tmp");
                File.WriteAllText(tmp, JsonSerializer.Serialize(result, Json));
                File.Move(tmp, Path.Combine(_outbox, $"{id}.json"), overwrite: true);
            }
            catch (Exception ex)
            {
                Log.Warn(Text.T($"Editor: result of {id} not written: {ex.Message}", $"Editor: esito di {id} non scritto: {ex.Message}"));
            }
        }
    }

    private Result Execute(Command command, string id)
    {
        if (command.Undo is { } undo) return Undo(undo);
        if (command.Settings is { } settings)
        {
            var failures = WorldSettings.Apply(settings);
            return new Result
            {
                Applied = 1,
                Failed = failures.Count,
                Failures = failures.Select(f => new Failure(-1, 0, 0, f.Reason, f.Key)).ToList(),
            };
        }
        var ops = command.Ops ?? [];
        if (ops.Count > MaxOps) throw new InvalidDataException($"too many operations ({ops.Count}, max {MaxOps})");

        var result = new Result();
        var area = Area(ops);
        var begun = _history.Begin(id, area);
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
                failure = $"error: {ex.Message}";
            }
            if (failure == Unchanged) continue;
            if (failure == null)
            {
                result.Applied++;
            }
            else
            {
                result.Failed++;
                if (result.Failures.Count < 20) result.Failures.Add(new Failure(i, op.X, op.Y, failure, null));
            }
        }
        _history.Finish(begun, result.Applied > 0);
        if (result.Applied > 0)
        {
            Sync(area);
            result.UndoId = id;
        }
        return result;
    }

    /// <summary>
    /// Tile che il comando può cambiare: quelle indicate e un bordo (i vicini cambiano frame). Dove c'è o si piazza un
    /// oggetto di più tile (mobili, casse) il bordo è largo <see cref="Margin"/>: l'oggetto intero cambia con lui.
    /// </summary>
    private static HashSet<long> Area(List<EditOp> ops)
    {
        var area = new HashSet<long>();
        foreach (var op in ops)
        {
            if (op.X < 0 || op.Y < 0 || op.X >= Main.maxTilesX || op.Y >= Main.maxTilesY) continue;
            var tile = Main.tile[op.X, op.Y];
            var big = (tile.HasTile && Main.tileFrameImportant[tile.TileType])
                      || (op.Op == "place-tile" && op.Type is { } type && type >= 0 && type < TileLoader.TileCount && Main.tileFrameImportant[type]);
            var r = big ? Margin : 1;
            for (var y = Math.Max(op.Y - r, 0); y <= Math.Min(op.Y + r, Main.maxTilesY - 1); y++)
                for (var x = Math.Max(op.X - r, 0); x <= Math.Min(op.X + r, Main.maxTilesX - 1); x++)
                    area.Add(EditHistory.Key(x, y));
        }
        return area;
    }

    private Result Undo(string id)
    {
        var undone = _history.Undo(id) ?? throw new InvalidOperationException("this change can no longer be undone");
        if (undone.Area.Count > 0) Sync(undone.Area);
        return new Result
        {
            Applied = undone.Restored,
            Failed = undone.Skipped,
            Failures = undone.SkippedTiles.Take(20).Select(t => new Failure(-1, t.X, t.Y, "changed since", null)).ToList(),
        };
    }

    /// <summary>Un'operazione. Restituisce null se riuscita, <see cref="Unchanged"/> se la tile era già così, altrimenti il motivo.</summary>
    private static string? Apply(EditOp op)
    {
        // Bordi: il gioco non lascia toccare le ultime tile del mondo
        if (op.X < 10 || op.Y < 10 || op.X >= Main.maxTilesX - 10 || op.Y >= Main.maxTilesY - 10) return "outside the world";
        var tile = Main.tile[op.X, op.Y];
        switch (op.Op)
        {
            case "place-tile":
            {
                if (op.Type is not { } type || type < 0 || type >= TileLoader.TileCount) return "invalid block type";
                if (tile.HasTile)
                {
                    if (tile.TileType == type) return Unchanged;
                    // Un blocco al posto di un altro (come il cambio di blocco col piccone): solo tra blocchi normali
                    if (Main.tileFrameImportant[tile.TileType] || Main.tileFrameImportant[type]) return "occupied";
                    return WorldGen.ReplaceTile(op.X, op.Y, (ushort)type, op.Style) ? null : "cannot be replaced";
                }
                WorldGen.PlaceTile(op.X, op.Y, type, mute: true, forced: true, plr: -1, style: op.Style);
                var placed = Main.tile[op.X, op.Y];
                // Mobili: l'ancora può non essere la tile indicata, basta che l'oggetto ci sia
                return placed.HasTile && placed.TileType == type ? null : "cannot be placed here";
            }
            case "kill-tile":
            {
                if (!tile.HasTile) return Unchanged;
                WorldGen.KillTile(op.X, op.Y, fail: false, effectOnly: false, noItem: true);
                // Le casse con degli oggetti dentro non si rompono (come nel gioco)
                return Main.tile[op.X, op.Y].HasTile ? "cannot be removed (full chest?)" : null;
            }
            case "place-wall":
            {
                if (op.Type is not { } type || type <= 0 || type >= WallLoader.WallCount) return "invalid wall type";
                if (tile.WallType == type) return Unchanged;
                if (tile.WallType != 0) return WorldGen.ReplaceWall(op.X, op.Y, (ushort)type) ? null : "cannot be replaced";
                WorldGen.PlaceWall(op.X, op.Y, type, mute: true);
                return Main.tile[op.X, op.Y].WallType == type ? null : "cannot be placed here";
            }
            case "kill-wall":
            {
                if (tile.WallType == 0) return Unchanged;
                // Non WorldGen.KillWall: lascerebbe cadere il muro come oggetto. Come lui, poi si ricalcolano i bordi
                tile.WallType = 0;
                tile.WallColor = 0;
                tile.IsWallFullbright = false;
                tile.IsWallInvisible = false;
                WorldGen.SquareWallFrame(op.X, op.Y);
                return null;
            }
            default:
                return $"unknown operation: {op.Op}";
        }
    }

    /// <summary>
    /// Manda le tile cambiate ai client e le segna da ridisegnare: a quadrati di <see cref="SquareSize"/> tile su una
    /// griglia fissa, solo quelli toccati (un tratto lungo in diagonale non manda tutto il rettangolo che lo contiene).
    /// </summary>
    private void Sync(IEnumerable<long> tiles)
    {
        var squares = new HashSet<long>();
        foreach (var key in tiles)
        {
            var (x, y) = EditHistory.FromKey(key);
            squares.Add(EditHistory.Key(x / SquareSize, y / SquareSize));
        }
        foreach (var square in squares)
        {
            var (sx, sy) = EditHistory.FromKey(square);
            var (x, y) = (sx * SquareSize, sy * SquareSize);
            var width = Math.Min(SquareSize, Main.maxTilesX - x);
            var height = Math.Min(SquareSize, Main.maxTilesY - y);
            if (Main.netMode == NetmodeID.Server) NetMessage.SendTileSquare(-1, x, y, width, height);
            _changed?.Invoke(x, y, width, height);
        }
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
            Log.Warn(Text.T($"Editor: catalog not written: {ex.Message}", $"Editor: catalogo non scritto: {ex.Message}"));
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
        public WorldSettings.Changes? Settings { get; set; }
        /// <summary>Id del comando "ops" da annullare.</summary>
        public string? Undo { get; set; }
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
        /// <summary>Comando "ops" che ha cambiato qualcosa: id da mandare in "undo" per annullarlo.</summary>
        public string? UndoId { get; set; }
    }

    /// <param name="Setting">Settaggio non cambiato (comandi "settings"), allora Index = -1.</param>
    private sealed record Failure(int Index, int X, int Y, string Reason, string? Setting);

    private sealed class Catalog
    {
        public int Format { get; set; } = WorldEditor.Format;
        public List<CatalogEntry> Tiles { get; set; } = [];
        public List<CatalogEntry> Walls { get; set; } = [];
    }

    private sealed record CatalogEntry(int Type, string Name, string? Mod, bool? Object);
}

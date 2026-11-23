using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using Terraria;
using Terraria.ID;

namespace TmmLiveMap;

/// <summary>
/// Annulla delle modifiche dell'editor del mondo. Prima di ogni comando si salvano le tile che può toccare (quelle
/// indicate più un margine: bordi, mobili di più tile) e le casse che ci sono; dopo, le stesse tile come le ha
/// lasciate il comando. Annullare rimette le tile di prima, ma solo dove il mondo è ancora come l'aveva lasciato il
/// comando: quello che i giocatori hanno cambiato nel frattempo resta.
///
/// Si tengono gli ultimi <see cref="Keep"/> comandi, al massimo <see cref="MaxTiles"/> tile in tutto (circa 30 byte
/// ciascuna), in memoria: un riavvio del server li perde. Non si salvano cartelli e tile entity (cornici, manichini,
/// sensori…): annullando la rimozione di uno di quegli oggetti torna l'oggetto, non il suo contenuto.
/// </summary>
public sealed class EditHistory
{
    private const int Keep = 50;
    private const long MaxTiles = 2_000_000;

    /// <summary>Dati grezzi di una tile: i cinque blocchi di dati di Terraria (tipo, muro, liquido, fili e stato, luce).</summary>
    private static readonly int TileBytes =
        Unsafe.SizeOf<TileTypeData>() + Unsafe.SizeOf<WallTypeData>() + Unsafe.SizeOf<LiquidData>()
        + Unsafe.SizeOf<TileWallWireStateData>() + Unsafe.SizeOf<TileWallBrightnessInvisibilityData>();

    private sealed record ChestState(int X, int Y, string Name, Item[] Items);

    private sealed class Entry(string id, long[] coords, byte[] before, List<ChestState> chests)
    {
        public string Id { get; } = id;
        /// <summary>Tile salvate: (x &lt;&lt; 32) | y.</summary>
        public long[] Coords { get; } = coords;
        public byte[] Before { get; } = before;
        public byte[] After { get; set; } = [];
        /// <summary>Casse con l'angolo nell'area, prima del comando.</summary>
        public List<ChestState> Chests { get; } = chests;
    }

    private readonly LinkedList<Entry> _entries = new();
    private long _tiles;

    public static long Key(int x, int y) => (long)x << 32 | (uint)y;
    public static (int X, int Y) FromKey(long key) => ((int)(key >> 32), (int)key);

    /// <summary>Prima del comando: salva le tile indicate e le casse nell'area. Da completare con <see cref="Finish"/>.</summary>
    public object Begin(string id, HashSet<long> area)
    {
        var coords = area.ToArray();
        var before = new byte[coords.Length * TileBytes];
        for (var i = 0; i < coords.Length; i++)
        {
            var (x, y) = FromKey(coords[i]);
            Save(x, y, before.AsSpan(i * TileBytes, TileBytes));
        }
        var chests = new List<ChestState>();
        foreach (var chest in Main.chest)
        {
            if (chest == null || !area.Contains(Key(chest.x, chest.y))) continue;
            chests.Add(new ChestState(chest.x, chest.y, chest.name ?? "", chest.item.Select(item => item?.Clone() ?? new Item()).ToArray()));
        }
        return new Entry(id, coords, before, chests);
    }

    /// <summary>Dopo il comando: salva le tile come le ha lasciate e tiene la voce (se il comando ha cambiato qualcosa).</summary>
    public void Finish(object begun, bool changed)
    {
        var entry = (Entry)begun;
        if (!changed) return;
        entry.After = new byte[entry.Before.Length];
        for (var i = 0; i < entry.Coords.Length; i++)
        {
            var (x, y) = FromKey(entry.Coords[i]);
            Save(x, y, entry.After.AsSpan(i * TileBytes, TileBytes));
        }
        _entries.AddLast(entry);
        _tiles += entry.Coords.Length;
        while (_entries.Count > Keep || (_tiles > MaxTiles && _entries.Count > 1))
        {
            _tiles -= _entries.First!.Value.Coords.Length;
            _entries.RemoveFirst();
        }
    }

    public sealed record UndoResult(int Restored, int Skipped, List<(int X, int Y)> SkippedTiles, List<long> Area);

    /// <summary>
    /// Annulla il comando <paramref name="id"/>. Null se non c'è più (troppo vecchio, server riavviato). Errore (eccezione)
    /// se una cassa piazzata dal comando nel frattempo è stata riempita: annullando si perderebbero gli oggetti.
    /// </summary>
    public UndoResult? Undo(string id)
    {
        var node = _entries.Last;
        while (node != null && node.Value.Id != id) node = node.Previous;
        if (node == null) return null;
        var entry = node.Value;
        var area = entry.Coords.ToHashSet();

        // Casse nate col comando (nell'area ora, non prima): si tolgono, ma solo se ancora vuote
        var previous = entry.Chests.Select(c => Key(c.X, c.Y)).ToHashSet();
        var created = new List<int>();
        for (var i = 0; i < Main.chest.Length; i++)
        {
            var chest = Main.chest[i];
            if (chest == null || !area.Contains(Key(chest.x, chest.y)) || previous.Contains(Key(chest.x, chest.y))) continue;
            if (chest.item.Any(item => item is { IsAir: false })) throw new InvalidOperationException("a chest placed by this change now contains items");
            created.Add(i);
        }

        var current = new byte[TileBytes];
        var restored = new List<long>();
        var skipped = new List<(int, int)>();
        for (var i = 0; i < entry.Coords.Length; i++)
        {
            var (x, y) = FromKey(entry.Coords[i]);
            Save(x, y, current);
            var after = entry.After.AsSpan(i * TileBytes, TileBytes);
            if (!current.AsSpan().SequenceEqual(after))
            {
                // Cambiata dopo il comando (giocatori, sabbia che cade, erba…): resta com'è
                if (!current.AsSpan().SequenceEqual(entry.Before.AsSpan(i * TileBytes, TileBytes))) skipped.Add((x, y));
                continue;
            }
            var before = entry.Before.AsSpan(i * TileBytes, TileBytes);
            if (after.SequenceEqual(before)) continue; // non toccata dal comando (bordo): niente da rimettere
            Load(x, y, before);
            restored.Add(entry.Coords[i]);
        }

        foreach (var i in created)
        {
            var chest = Main.chest[i];
            if (chest != null && !IsContainer(chest.x, chest.y)) Main.chest[i] = null;
        }
        foreach (var state in entry.Chests)
        {
            if (Chest.FindChest(state.X, state.Y) != -1 || !IsContainer(state.X, state.Y)) continue;
            var index = Chest.CreateChest(state.X, state.Y);
            if (index < 0) continue;
            Main.chest[index].name = state.Name;
            for (var slot = 0; slot < state.Items.Length && slot < Main.chest[index].item.Length; slot++) Main.chest[index].item[slot] = state.Items[slot].Clone();
        }

        Reframe(area, restored);
        _tiles -= entry.Coords.Length;
        _entries.Remove(node);
        return new UndoResult(restored.Count, skipped.Count, skipped, restored);
    }

    /// <summary>Le tile rimesse hanno i loro frame; quelle intorno, fuori dall'area, si adattano a loro (bordi).</summary>
    private static void Reframe(HashSet<long> area, List<long> restored)
    {
        var done = new HashSet<long>();
        foreach (var key in restored)
        {
            var (x, y) = FromKey(key);
            foreach (var (nx, ny) in new[] { (x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1) })
            {
                var neighbour = Key(nx, ny);
                if (area.Contains(neighbour) || !done.Add(neighbour) || !WorldGen.InWorld(nx, ny, 1)) continue;
                try
                {
                    WorldGen.TileFrame(nx, ny);
                    Framing.WallFrame(nx, ny);
                }
                catch (Exception)
                {
                    // Un blocco di una mod che non sa ricalcolarsi qui: resta col frame che aveva
                }
            }
        }
    }

    private static bool IsContainer(int x, int y)
    {
        var tile = Main.tile[x, y];
        return tile.HasTile && (TileID.Sets.BasicChest[tile.TileType] || TileID.Sets.BasicDresser[tile.TileType]);
    }

    private static void Save(int x, int y, Span<byte> dest)
    {
        var tile = Main.tile[x, y];
        var offset = 0;
        Write(dest, ref offset, tile.Get<TileTypeData>());
        Write(dest, ref offset, tile.Get<WallTypeData>());
        Write(dest, ref offset, tile.Get<LiquidData>());
        Write(dest, ref offset, tile.Get<TileWallWireStateData>());
        Write(dest, ref offset, tile.Get<TileWallBrightnessInvisibilityData>());
    }

    private static void Load(int x, int y, ReadOnlySpan<byte> src)
    {
        var tile = Main.tile[x, y];
        var offset = 0;
        tile.Get<TileTypeData>() = Read<TileTypeData>(src, ref offset);
        tile.Get<WallTypeData>() = Read<WallTypeData>(src, ref offset);
        tile.Get<LiquidData>() = Read<LiquidData>(src, ref offset);
        tile.Get<TileWallWireStateData>() = Read<TileWallWireStateData>(src, ref offset);
        tile.Get<TileWallBrightnessInvisibilityData>() = Read<TileWallBrightnessInvisibilityData>(src, ref offset);
    }

    private static void Write<T>(Span<byte> dest, ref int offset, T value) where T : unmanaged
    {
        MemoryMarshal.Write(dest[offset..], in value);
        offset += Unsafe.SizeOf<T>();
    }

    private static T Read<T>(ReadOnlySpan<byte> src, ref int offset) where T : unmanaged
    {
        var value = MemoryMarshal.Read<T>(src[offset..]);
        offset += Unsafe.SizeOf<T>();
        return value;
    }
}

using System.Buffers.Binary;

namespace TmmLiveMap;

/// <summary>
/// Dati grezzi delle tile, per disegnare i blocchi con i loro sprite nel pannello (li disegna il browser;
/// il server copia solo i dati). Un file per riquadro, tiles/{cx}_{cy}.bin, compresso gzip:
///   "TMMT" · formato (u8) · byte per tile (u8) · larghezza (u16) · altezza (u16) · tile riga per riga
/// Ogni tile, little endian:
///   0  u16 tipo del blocco (0xFFFF = nessun blocco)
///   2  i16 frameX, 4 i16 frameY: quale parte del foglio di sprite. Caricando il mondo il gioco li tiene solo per
///      i blocchi "frame important" (mobili, oggetti di più tile) e mette -1 agli altri, che calcolano i client:
///      la mod tModLoader li calcola con il codice del gioco prima di disegnare (TmmLiveMap.EnsureFramed); il
///      plugin TShock per ora no (-1: il pannello usa lo schema standard dei blocchi)
///   6  u16 tipo del muro (0 = nessuno)
///   8  u8  forma (0 pieno, 1 mezzo blocco, 2–5 pendenze) | 0x08 disattivato da un attuatore | 0x10 liquido
///   9  u8  vernice del blocco
/// </summary>
public static class TileData
{
    public const int Format = 1;
    public const int Size = 10;
    public const byte Actuated = 0x08, Liquid = 0x10;

    public static void Write(Span<byte> dest, bool hasTile, int type, int frameX, int frameY, int wall, int shape, bool actuated, bool liquid, int paint)
    {
        BinaryPrimitives.WriteUInt16LittleEndian(dest, hasTile ? (ushort)type : (ushort)0xFFFF);
        BinaryPrimitives.WriteInt16LittleEndian(dest[2..], (short)frameX);
        BinaryPrimitives.WriteInt16LittleEndian(dest[4..], (short)frameY);
        BinaryPrimitives.WriteUInt16LittleEndian(dest[6..], (ushort)wall);
        dest[8] = (byte)((shape & 0x07) | (actuated ? Actuated : 0) | (liquid ? Liquid : 0));
        dest[9] = (byte)paint;
    }

    public static void Empty(Span<byte> dest)
    {
        dest.Clear();
        BinaryPrimitives.WriteUInt16LittleEndian(dest, 0xFFFF);
    }
}

/// <summary>
/// types.json: cosa sono i tipi di blocco e di muro, per scegliere e trovare gli sprite. Gli indici sono i tipi.
/// Per quelli delle mod: mod e percorso della texture nel .tmod ("CalamityMod/Tiles/Abyss/AbyssGravel" →
/// Tiles/Abyss/AbyssGravel.rawimg dentro CalamityMod.tmod).
/// </summary>
public sealed class TileTypes
{
    public int Format { get; set; } = TileData.Format;
    /// <summary>Blocchi e muri di Terraria: i tipi da qui in poi sono delle mod.</summary>
    public int VanillaTiles { get; set; }
    public int VanillaWalls { get; set; }
    /// <summary>Per tipo di blocco: frame salvati dal gioco (mobili, oggetti di più tile).</summary>
    public bool[] FrameImportant { get; set; } = [];
    /// <summary>Per tipo di blocco: blocco pieno (sceglie lo sprite secondo i vicini).</summary>
    public bool[] Solid { get; set; } = [];
    public Dictionary<int, ModType> ModTiles { get; set; } = [];
    public Dictionary<int, ModType> ModWalls { get; set; } = [];
}

public sealed record ModType(string Mod, string Name, string Texture);

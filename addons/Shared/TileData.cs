using System.Buffers.Binary;

namespace TmmLiveMap;

/// <summary>
/// Dati grezzi delle tile, per disegnare i blocchi con i loro sprite nel pannello (li disegna il browser;
/// il server copia solo i dati). Un file per riquadro, tiles/{cx}_{cy}.bin, compresso gzip:
///   "TMMT" · formato (u8) · byte per tile (u8) · larghezza (u16) · altezza (u16) · tile riga per riga
/// Ogni tile, little endian:
///   0  u16 tipo del blocco (0xFFFF = nessun blocco)
///   2  i16 frameX, 4 i16 frameY: quale parte del foglio di sprite. Caricando il mondo il gioco li tiene solo per
///      i blocchi "frame important" (mobili, oggetti di più tile); per gli altri mette -1 (Terraria) o 0 (mod, dal
///      .twld) e li calcolano i client. La mod tModLoader li calcola con il codice del gioco prima di disegnare
///      (TmmLiveMap.EnsureFramed), una volta per tile a ogni caricamento del mondo; il plugin TShock per ora no
///      (-1: il pannello usa lo schema standard dei blocchi)
///   6  u16 tipo del muro (0 = nessuno)
///   8  u8  forma (0 pieno, 1 mezzo blocco, 2–5 pendenze) | 0x08 disattivato da un attuatore | 0x10 liquido
///   9  u8  vernice del blocco
///   10 u8  wallFrameX / 36, 11 u8 wallFrameY / 36: quale pezzo (32×32, a passi di 36) del foglio del muro; come i
///      frame dei blocchi li calcolano i client, e la mod tModLoader prima di disegnare; 0xFF = non calcolato
///   12 u8  tipo del liquido (0 acqua, 1 lava, 2 miele, 3 shimmer), 13 u8 quantità (0–255; 0 = niente liquido)
/// </summary>
public static class TileData
{
    public const int Format = 3;
    public const int Size = 14;
    public const byte Unknown = 0xFF;
    public const byte Actuated = 0x08, Liquid = 0x10;

    /// <param name="wallFrameX">Frame del muro in pixel (come nel gioco), oppure -1 se non è calcolato.</param>
    /// <param name="liquidAmount">Quantità del liquido (0–255): con 0 non c'è.</param>
    public static void Write(Span<byte> dest, bool hasTile, int type, int frameX, int frameY, int wall, int shape, bool actuated, int liquidType, int liquidAmount,
        int paint, int wallFrameX, int wallFrameY)
    {
        var liquid = liquidAmount > 0;
        BinaryPrimitives.WriteUInt16LittleEndian(dest, hasTile ? (ushort)type : (ushort)0xFFFF);
        BinaryPrimitives.WriteInt16LittleEndian(dest[2..], (short)frameX);
        BinaryPrimitives.WriteInt16LittleEndian(dest[4..], (short)frameY);
        BinaryPrimitives.WriteUInt16LittleEndian(dest[6..], (ushort)wall);
        dest[8] = (byte)((shape & 0x07) | (actuated ? Actuated : 0) | (liquid ? Liquid : 0));
        dest[9] = (byte)paint;
        dest[10] = wallFrameX < 0 ? Unknown : (byte)Math.Min(254, wallFrameX / 36);
        dest[11] = wallFrameY < 0 ? Unknown : (byte)Math.Min(254, wallFrameY / 36);
        dest[12] = liquid ? (byte)liquidType : (byte)0;
        dest[13] = (byte)Math.Clamp(liquidAmount, 0, 255);
    }

    public static void Empty(Span<byte> dest)
    {
        dest.Clear();
        BinaryPrimitives.WriteUInt16LittleEndian(dest, 0xFFFF);
        dest[10] = dest[11] = Unknown;
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

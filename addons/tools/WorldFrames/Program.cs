using System.Buffers.Binary;
using System.IO.Compression;
using System.Reflection;
using ModFramework;
using Terraria;
using Terraria.ID;
using Terraria.Utilities;

// Frame delle tile per la mappa dal file del mondo (senza LiveMap): quale parte del foglio di sprite usare per ogni
// blocco e muro, calcolata dal codice di Terraria (tramite OTAPI) come fa il client quando riceve il mondo, con le
// fusioni tra blocchi diversi, l'erba, le varianti. L'agent gli passa i dati grezzi delle tile ricavati dal .wld
// (tiles/{cx}_{cy}.bin, formato di addons/Shared/TileData.cs, frame -1) e lui scrive gli stessi file con i frame.
//
//   WorldFrames <cartella dei dati> <cartella di uscita> <larghezza del mondo> <altezza> <larghezza riquadro> <altezza>
//   su stdin: una riga "cx cy" per ogni riquadro da calcolare (nella cartella dei dati servono anche i vicini)
//
// Ogni riquadro si calcola in una finestra con un margine di tile attorno (i vicini contano, e TileFrame lavora solo a
// più di 5 tile dal bordo del mondo). Le varianti casuali hanno un seme fisso per riquadro: a parità di dati, a ogni
// salvataggio del mondo escono gli stessi frame.

const int Size = 12, NoTile = 0xFFFF, Margin = 8;
const byte UnknownFrame = 0xFF;

if (args.Length != 6)
{
    Console.Error.WriteLine("Uso: WorldFrames <dati> <uscita> <larghezza> <altezza> <larghezza riquadro> <altezza riquadro>");
    return 2;
}
var (input, output) = (args[0], args[1]);
var (worldW, worldH, chunkW, chunkH) = (int.Parse(args[2]), int.Parse(args[3]), int.Parse(args[4]), int.Parse(args[5]));

// Terraria tiene alcune librerie come risorse incorporate e le carica quando servono
System.Runtime.Loader.AssemblyLoadContext.Default.Resolving += (context, name) =>
{
    var terraria = typeof(Main).Assembly;
    var resource = terraria.GetManifestResourceNames().FirstOrDefault(r => r.EndsWith($".{name.Name}.dll", StringComparison.Ordinal));
    if (resource == null) return null;
    using var stream = terraria.GetManifestResourceStream(resource)!;
    return context.LoadFromStream(stream);
};

// Main ha bisogno della cartella dei salvataggi (la imposta l'avvio del gioco); poi le proprietà dei blocchi
// (pieni, fusioni con la terra, coppie che si fondono…), come all'avvio del gioco
const BindingFlags Static = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
typeof(Main).Assembly.GetType("Terraria.Program")!.GetField("SavePath", Static)?.SetValue(null, Path.Combine(Path.GetTempPath(), "tmm-worldframes"));
foreach (var name in new[] { "Initialize_TileAndNPCData1", "Initialize_TileAndNPCData2" })
    (typeof(Main).GetMethod(name, Static) ?? throw new MissingMethodException("Main", name)).Invoke(null, null);
// Come un server dedicato (lo stesso caso di TShock): niente minimappa, suoni o effetti da aggiornare mentre si
// calcolano i frame
Main.dedServ = true;
// Tabelle dei frame dei muri (e delle fusioni tra muri), come all'avvio del gioco
(typeof(Framing).GetMethod("Initialize", Static) ?? throw new MissingMethodException("Framing", "Initialize")).Invoke(null, null);

Directory.CreateDirectory(output);
var chunks = new Dictionary<(int, int), (int W, int H, byte[] Data)?>();
(int W, int H, byte[] Data)? Load(int cx, int cy)
{
    if (chunks.TryGetValue((cx, cy), out var hit)) return hit;
    (int, int, byte[])? chunk = null;
    var path = Path.Combine(input, $"{cx}_{cy}.bin");
    if (File.Exists(path))
    {
        using var gzip = new GZipStream(File.OpenRead(path), CompressionMode.Decompress);
        using var ms = new MemoryStream();
        gzip.CopyTo(ms);
        var raw = ms.ToArray();
        if (raw.Length >= 10 && raw[4] == 2 && raw[5] == Size)
            chunk = (BinaryPrimitives.ReadUInt16LittleEndian(raw.AsSpan(6)), BinaryPrimitives.ReadUInt16LittleEndian(raw.AsSpan(8)), raw);
    }
    return chunks[(cx, cy)] = chunk;
}

// Finestra: tile del gioco riusate da un riquadro all'altro
var winW = chunkW + 2 * Margin;
var winH = chunkH + 2 * Margin;
Main.maxTilesX = winW;
Main.maxTilesY = winH;
var tiles = new DefaultCollection<ITile>(winW, winH);
_ = tiles[0, 0]; // la collezione crea il suo array alla prima lettura
for (var x = 0; x < winW; x++) for (var y = 0; y < winH; y++) tiles[x, y] = new Tile();
Main.tile = tiles;

var done = 0;
var errors = 0;
for (var line = Console.ReadLine(); line != null; line = Console.ReadLine())
{
    var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
    if (parts.Length != 2) continue;
    var (cx, cy) = (int.Parse(parts[0]), int.Parse(parts[1]));
    var target = Load(cx, cy);
    if (target is not { } chunk) continue;
    var (x0, y0) = (cx * chunkW - Margin, cy * chunkH - Margin);

    // Dati del riquadro e dei vicini nella finestra
    for (var lx = 0; lx < winW; lx++)
    {
        for (var ly = 0; ly < winH; ly++)
        {
            var tile = tiles[lx, ly];
            tile.ClearEverything();
            var (gx, gy) = (x0 + lx, y0 + ly);
            if (gx < 0 || gy < 0 || gx >= worldW || gy >= worldH) continue;
            if (Load(gx / chunkW, gy / chunkH) is not { } c) continue;
            var o = 10 + ((gy % chunkH) * c.W + gx % chunkW) * Size;
            var d = c.Data.AsSpan(o, Size);
            int type = BinaryPrimitives.ReadUInt16LittleEndian(d), wall = BinaryPrimitives.ReadUInt16LittleEndian(d[6..]);
            if (type != NoTile)
            {
                tile.active(true);
                // Blocchi delle mod: per i vicini conta un blocco pieno qualsiasi (pietra); il loro frame resta al pannello
                tile.type = (ushort)(type < TileID.Count ? type : TileID.Stone);
                tile.frameX = BinaryPrimitives.ReadInt16LittleEndian(d[2..]);
                tile.frameY = BinaryPrimitives.ReadInt16LittleEndian(d[4..]);
                var shape = d[8] & 0x07;
                if (shape == 1) tile.halfBrick(true);
                else if (shape > 1) tile.slope((byte)(shape - 1));
                if ((d[8] & 0x08) != 0) tile.inActive(true);
            }
            // Muri delle mod: per il frame del muro conta solo che ci sia (lo schema è quello di Terraria)
            if (wall != 0) tile.wall = (ushort)(wall < WallID.Count ? wall : WallID.Stone);
            if ((d[8] & 0x10) != 0) tile.liquid = 255;
        }
    }

    // Frame del riquadro, con il codice del gioco
    Main.rand = new UnifiedRandom(cx * 7919 + cy * 104729 + 1); // WorldGen.genRand è Main.rand
    for (var x = 0; x < chunk.W; x++)
    {
        for (var y = 0; y < chunk.H; y++)
        {
            var (lx, ly) = (x + Margin, y + Margin);
            var tile = tiles[lx, ly];
            var o = 10 + (y * chunk.W + x) * Size;
            int type = BinaryPrimitives.ReadUInt16LittleEndian(chunk.Data.AsSpan(o));
            try
            {
                if (type != NoTile && type < TileID.Count && !Main.tileFrameImportant[type])
                {
                    WorldGen.TileFrameCosmetic(lx, ly, tile, true);
                    BinaryPrimitives.WriteInt16LittleEndian(chunk.Data.AsSpan(o + 2), tile.frameX);
                    BinaryPrimitives.WriteInt16LittleEndian(chunk.Data.AsSpan(o + 4), tile.frameY);
                }
                if (tile.wall != 0)
                {
                    Framing.WallFrame(lx, ly, true);
                    chunk.Data[o + 10] = (byte)Math.Min(254, tile.wallFrameX() / 36);
                    chunk.Data[o + 11] = (byte)Math.Min(254, tile.wallFrameY() / 36);
                }
            }
            catch (Exception ex)
            {
                // Tile che il gioco non sa incorniciare fuori dal mondo vero: resta da calcolare al pannello
                chunk.Data[o + 10] = chunk.Data[o + 11] = UnknownFrame;
                if (errors++ == 0) Console.Error.WriteLine($"Frame di ({x0 + lx}, {y0 + ly}) non calcolato: {ex}");
            }
        }
    }

    var tmp = Path.Combine(output, $"{cx}_{cy}.bin.tmp");
    using (var file = File.Create(tmp))
    using (var gzip = new GZipStream(file, CompressionLevel.Optimal))
        gzip.Write(chunk.Data);
    File.Move(tmp, Path.Combine(output, $"{cx}_{cy}.bin"), overwrite: true);
    done++;
}
Console.WriteLine(errors > 0 ? $"{done} riquadri, {errors} tile senza frame" : $"{done} riquadri");
return 0;

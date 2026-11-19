using System.Collections;
using System.Reflection;
using Microsoft.Xna.Framework;
using MonoMod.Cil;
using Terraria;
using Terraria.ID;
using Terraria.Localization;
using Terraria.Map;
using Terraria.ModLoader;

namespace TmmLiveMap;

/// <summary>
/// LiveMap per tModLoader: la mappa del mondo in tempo reale per il pannello di tModManager, come il plugin
/// LiveMap per TShock (stesso formato, stessa cartella "map" letta dal pannello). Solo lato server.
///
/// Cartella: LiveMap/ nella cartella dei salvataggi del server (accanto a Worlds/ e Mods/):
///   config.json, manifest.json, chunks/, overview.png, players.json, viewer (vedi MapWriter).
/// </summary>
public class TmmLiveMap : Mod
{
    public override void Load()
    {
        if (!Main.dedServ) return; // mod "side = Server": nel gioco non fa nulla
        Log.Info = message => { Logger.Info(message); Console.WriteLine($"[LiveMap] {message}"); };
        Log.Warn = message => { Logger.Warn(message); Console.WriteLine($"[LiveMap] {message}"); };
        Log.Error = message => { Logger.Error(message); Console.WriteLine($"[LiveMap] {message}"); };
        On_NetMessage.SendData += OnSendData;
        IL_MapHelper.CreateMapTile += MapColors.WithoutPlayerMap;
    }

    /// <summary>Ogni pacchetto che il server manda ai client: qui si scoprono le modifiche al mondo.</summary>
    private static void OnSendData(On_NetMessage.orig_SendData orig, int msgType, int remoteClient, int ignoreClient, NetworkText text,
        int number, float number2, float number3, float number4, int number5, int number6, int number7)
    {
        orig(msgType, remoteClient, ignoreClient, text, number, number2, number3, number4, number5, number6, number7);
        LiveMapSystem.Engine?.OnSendData(msgType, number, number2, number3, number4);
    }
}

public class LiveMapSystem : ModSystem
{
    public static MapEngine? Engine { get; private set; }

    public static string MapDir => Path.Combine(Main.SavePath, "LiveMap");
    public static string ConfigPath => Path.Combine(MapDir, "config.json");

    public override void OnWorldLoad()
    {
        if (!Main.dedServ) return;
        Engine?.Dispose();
        Engine = null;
        if (!MapColors.Prepare()) return;

        Directory.CreateDirectory(MapDir);
        _tileFramed = new System.Collections.BitArray(Main.maxTilesX * Main.maxTilesY);
        _wallFramed = new System.Collections.BitArray(Main.maxTilesX * Main.maxTilesY);
        var config = Config.Load(ConfigPath);
        Engine = new MapEngine(MapDir, config, Main.maxTilesX, Main.maxTilesY, Pixel, World, Players, ReadTile, Types());
        Log.Info($"Mappa pronta: {Engine.Cols}×{Engine.Rows} riquadri in {MapDir}" +
                 (config.SempreAttiva ? " (sempre attiva)" : " (si aggiorna quando il pannello la apre)"));
    }

    public override void OnWorldUnload()
    {
        _tileFramed = _wallFramed = null;
        Engine?.Dispose();
        Engine = null;
    }

    public override void PostUpdateEverything() => Engine?.OnGameUpdate();

    /// <summary>Colore della tile come nella minimappa del gioco, a piena luce.</summary>
    private static int Pixel(int x, int y)
    {
        EnsureFramed(x, y);
        var tile = MapHelper.CreateMapTile(x, y, 255);
        var color = MapHelper.GetMapTileXnaColor(ref tile);
        return color.R << 16 | color.G << 8 | color.B;
    }

    /// <summary>
    /// Frame della tile (quale parte del foglio di sprite usare). Caricando il mondo il gioco li mette a -1 per i
    /// blocchi normali di Terraria e a 0 per quelli delle mod (letti dal .twld), e li calcolano i client; sul server
    /// servono per gli sprite del pannello (e per il colore di alcuni blocchi). Dato che 0 è anche un frame valido,
    /// come per i muri si tiene il conto delle tile già calcolate (i blocchi "frame important", mobili e oggetti di
    /// più tile, hanno i frame salvati nel mondo e non si toccano). Si calcolano come WorldGen.EveryTileFrame, che il server usa dopo aver generato un mondo:
    /// TileFrame senza "azioni" (sabbia che cade, liquidi, oggetti che si rompono). Lo fa il codice del gioco e
    /// delle mod, quindi anche gli schemi di frame delle mod sono giusti. Una volta sola per tile.
    /// </summary>
    private static void EnsureFramed(int x, int y)
    {
        var t = Main.tile[x, y];
        var index = y * Main.maxTilesX + x;
        var tile = t.HasTile && !Main.tileFrameImportant[t.TileType] && _tileFramed is { } tiles && !tiles[index];
        // Muri: per sapere se il frame è calcolato non c'è un valore apposta (0 è un frame valido): si tiene il conto qui.
        // Dopo, quando un muro cambia, il gioco lo ricalcola da sé
        var wall = t.WallType > 0 && _wallFramed is { } framed && !framed[index];
        if (!tile && !wall) return;
        var (liquid, actions) = (WorldGen.noLiquidCheck, WorldGen.noTileActions);
        WorldGen.noLiquidCheck = true;
        WorldGen.noTileActions = true;
        try
        {
            if (tile)
            {
                WorldGen.TileFrame(x, y, resetFrame: true, noBreak: true);
                _tileFramed![index] = true;
            }
            if (wall)
            {
                Framing.WallFrame(x, y, resetFrame: true);
                _wallFramed![index] = true;
            }
        }
        finally
        {
            (WorldGen.noLiquidCheck, WorldGen.noTileActions) = (liquid, actions);
        }
    }

    /// <summary>Blocchi e muri a cui LiveMap ha già calcolato il frame da questo caricamento del mondo (un bit per tile).</summary>
    private static System.Collections.BitArray? _tileFramed, _wallFramed;

    /// <summary>Dati grezzi della tile, per gli sprite nel pannello (TileData).</summary>
    private static void ReadTile(int x, int y, Span<byte> dest)
    {
        var t = Main.tile[x, y];
        var wallFramed = t.WallType > 0 && _wallFramed?[y * Main.maxTilesX + x] == true;
        TileData.Write(dest, t.HasTile, t.TileType, t.TileFrameX, t.TileFrameY, t.WallType, (int)t.BlockType, t.IsActuated, t.LiquidType, t.LiquidAmount,
            t.TileColor, wallFramed ? t.WallFrameX : -1, wallFramed ? t.WallFrameY : -1);
    }

    /// <summary>Tipi di blocchi e muri, con mod e texture di quelli delle mod (types.json).</summary>
    private static TileTypes Types()
    {
        var types = new TileTypes
        {
            VanillaTiles = TileID.Count,
            VanillaWalls = WallID.Count,
            FrameImportant = Main.tileFrameImportant.Take(TileLoader.TileCount).ToArray(),
            Solid = Main.tileSolid.Take(TileLoader.TileCount).ToArray(),
        };
        for (var type = TileID.Count; type < TileLoader.TileCount; type++)
            if (TileLoader.GetTile(type) is { } tile) types.ModTiles[type] = new ModType(tile.Mod.Name, tile.Name, tile.Texture);
        for (var type = WallID.Count; type < WallLoader.WallCount; type++)
            if (WallLoader.GetWall(type) is { } wall) types.ModWalls[type] = new ModType(wall.Mod.Name, wall.Name, wall.Texture);
        return types;
    }

    private static WorldInfo World() => new(
        Main.worldName, Main.worldID, Main.maxTilesX, Main.maxTilesY,
        Main.spawnTileX, Main.spawnTileY, (int)Main.worldSurface, (int)Main.rockLayer);

    private static List<PlayerInfo> Players()
    {
        var list = new List<PlayerInfo>();
        for (var i = 0; i < Main.maxPlayers; i++)
        {
            var p = Main.player[i];
            if (p is not { active: true }) continue;
            list.Add(new PlayerInfo(p.name, MathF.Round(p.Center.X / 16f, 1), MathF.Round(p.Center.Y / 16f, 1),
                p.team, p.statLife, p.statLifeMax2, p.dead));
        }
        return list;
    }
}

/// <summary>
/// Le tabelle dei colori della minimappa sul server dedicato. Il gioco non le prepara (servono solo ai client):
///  - MapHelper.Initialize (colori di Terraria) non viene chiamato: lo si chiama qui. Alla fine prova a creare la
///    legenda della mappa, che sul server non si può: a quel punto i colori ci sono già, l'errore non conta;
///  - MapLoader.FinishSetup (colori dei blocchi e dei muri delle mod, dichiarati con AddMapEntry) sul server
///    esce subito: qui si fa lo stesso lavoro, senza la legenda (i nomi non servono).
/// </summary>
internal static class MapColors
{
    private const BindingFlags Static = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;

    // Non pubblici in tModLoader
    private static readonly FieldInfo ColorLookupField = typeof(MapHelper).GetField("colorLookup", Static) ?? throw new MissingFieldException("MapHelper", "colorLookup");
    private static readonly FieldInfo ModPositionField = typeof(MapHelper).GetField("modPosition", Static) ?? throw new MissingFieldException("MapHelper", "modPosition");

    private static Color[]? ColorLookup
    {
        get => (Color[]?)ColorLookupField.GetValue(null);
        set => ColorLookupField.SetValue(null, value);
    }

    private static ushort ModPosition => Convert.ToUInt16(ModPositionField.GetValue(null));

    /// <summary>
    /// CreateMapTile legge Main.Map (la mappa esplorata dal giocatore: sul server non c'è), all'inizio senza usarne
    /// il valore e per la neve vicino ad alcuni alberi. Qui quelle letture passano da MapAt: una tile vuota se manca.
    /// Crearla (Main.Map) costerebbe 4 byte per tile: 80 MB per un mondo grande.
    /// </summary>
    public static void WithoutPlayerMap(ILContext il)
    {
        var c = new ILCursor(il);
        var replaced = 0;
        while (c.TryGotoNext(MoveType.Before, i => i.MatchCallvirt<WorldMap>("get_Item")))
        {
            c.Next!.OpCode = Mono.Cecil.Cil.OpCodes.Call;
            c.Next.Operand = il.Import(typeof(MapColors).GetMethod(nameof(MapAt))!);
            replaced++;
        }
        if (replaced == 0) Log.Warn("CreateMapTile non legge più Main.Map: nessuna modifica (va bene, se non serve)");
    }

    public static MapTile MapAt(WorldMap? map, int x, int y) => map == null ? default : map[x, y];

    public static bool Prepare()
    {
        try
        {
            if (ColorLookup is not { Length: > 0 })
            {
                try
                {
                    MapHelper.Initialize();
                }
                catch (Exception) when (ColorLookup is { Length: > 0 })
                {
                    // Legenda della mappa (Lang.BuildMapAtlas) non disponibile sul server
                }
            }
            var modColors = SetupModMap();

            var tile = MapHelper.CreateMapTile(Main.spawnTileX, Main.spawnTileY, 255);
            MapHelper.GetMapTileXnaColor(ref tile);
            Log.Info($"Colori della mappa: {ColorLookup!.Length} ({modColors} dalle mod)");
            return true;
        }
        catch (Exception ex)
        {
            Log.Error($"I colori della mappa non sono disponibili su questo server, LiveMap disattivato: {ex}");
            return false;
        }
    }

    /// <summary>Come MapLoader.FinishSetup. Restituisce quanti colori delle mod ha aggiunto.</summary>
    private static int SetupModMap()
    {
        var loader = typeof(Mod).Assembly.GetType("Terraria.ModLoader.MapLoader") ?? throw new MissingMemberException("MapLoader");
        IDictionary Field(string name) => loader.GetField(name, Static)?.GetValue(null) as IDictionary ?? throw new MissingFieldException("MapLoader", name);
        var tileEntries = Field("tileEntries");
        var wallEntries = Field("wallEntries");
        var entryToTile = Field("entryToTile");
        var entryToWall = Field("entryToWall");

        // Già fatto (dal gioco o da un caricamento precedente)
        if (MapHelper.tileLookup.Length >= TileLoader.TileCount && MapHelper.wallLookup.Length >= WallLoader.WallCount
            && entryToTile.Count + entryToWall.Count > 0)
            return entryToTile.Count + entryToWall.Count;

        Array.Resize(ref MapHelper.tileLookup, TileLoader.TileCount);
        Array.Resize(ref MapHelper.wallLookup, WallLoader.WallCount);
        entryToTile.Clear();
        entryToWall.Clear();

        var modPosition = ModPosition;
        var colors = new List<Color>();
        FieldInfo? colorField = null;
        void Add(IDictionary entries, ushort[] lookup, IDictionary entryToType)
        {
            foreach (var type in entries.Keys.Cast<ushort>().Order())
            {
                lookup[type] = (ushort)(modPosition + colors.Count);
                foreach (var entry in (IEnumerable)entries[type]!)
                {
                    colorField ??= entry.GetType().GetField("color", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                                   ?? throw new MissingFieldException("MapEntry", "color");
                    entryToType[(ushort)(modPosition + colors.Count)] = type;
                    colors.Add((Color)colorField.GetValue(entry)!);
                }
            }
        }
        Add(tileEntries, MapHelper.tileLookup, entryToTile);
        Add(wallEntries, MapHelper.wallLookup, entryToWall);

        var lookup = ColorLookup!;
        Array.Resize(ref lookup, modPosition + colors.Count);
        colors.CopyTo(lookup, modPosition);
        ColorLookup = lookup;
        return colors.Count;
    }
}

/// <summary>"/mappa" nella console del server: stato della mappa; "/mappa rigenera" la ridisegna da capo.</summary>
public class MapCommand : ModCommand
{
    public override CommandType Type => CommandType.Console;
    public override string Command => "mappa";
    public override string Usage => "/mappa [rigenera|ricarica]";
    public override string Description => "Stato della mappa del pannello di tModManager (LiveMap)";

    public override void Action(CommandCaller caller, string input, string[] args)
    {
        var engine = LiveMapSystem.Engine;
        if (engine == null)
        {
            caller.Reply("[LiveMap] La mappa non è attiva (mondo non ancora caricato o colori non disponibili).", Color.Red);
            return;
        }
        switch (args.FirstOrDefault()?.ToLowerInvariant())
        {
            case "rigenera":
                engine.Regenerate();
                caller.Reply("[LiveMap] La mappa verrà ridisegnata da capo.", Color.LightGreen);
                return;
            case "ricarica":
                engine.Config = Config.Load(LiveMapSystem.ConfigPath);
                caller.Reply("[LiveMap] Configurazione ricaricata (ScalaPanoramica vale dal prossimo riavvio).", Color.LightGreen);
                return;
        }
        foreach (var line in engine.Status()) caller.Reply($"[LiveMap] {line}");
    }
}

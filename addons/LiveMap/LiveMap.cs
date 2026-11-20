using System.Collections;
using Terraria;
using Terraria.ID;
using Terraria.Map;
using TerrariaApi.Server;
using TmmLiveMap;
using TShockAPI;
using TShockAPI.Hooks;

namespace LiveMap;

/// <summary>
/// Mappa del mondo in tempo reale per il pannello (plugin TShock): riquadri PNG aggiornati solo dove il mondo
/// cambia. Il disegno (e tutto ciò che serve a non pesare sul server) è in Shared/MapEngine.cs, comune alla mod
/// TmmLiveMap per tModLoader; qui ci sono solo gli agganci a TShock.
/// </summary>
[ApiVersion(2, 1)]
public class LiveMap : TerrariaPlugin
{
    public override string Name => "LiveMap";
    public override Version Version => new(1, 6, 0);
    public override string Author => "tModManager";
    public override string Description => "Live world map for the tModManager panel.";

    private static string ConfigPath => Path.Combine(TShock.SavePath, "LiveMap.json");
    private static string MapDir => Path.Combine(TShock.SavePath, "map");

    private Command? _command;
    private MapEngine? _engine;

    /// <summary>Blocchi e muri a cui il plugin ha già calcolato il frame da questo avvio (un bit per tile).</summary>
    private static BitArray? _tileFramed, _wallFramed;

    public LiveMap(Main game) : base(game) { }

    public override void Initialize()
    {
        Log.Info = message => TShock.Log.ConsoleInfo($"[LiveMap] {message}");
        Log.Warn = message => TShock.Log.ConsoleWarn($"[LiveMap] {message}");
        Log.Error = message => TShock.Log.ConsoleError($"[LiveMap] {message}");
        Text.Culture = () => Terraria.Localization.Language.ActiveCulture.Name;
        Directory.CreateDirectory(MapDir);

        _command = new Command("livemap.admin", MapCommand, "map", "mappa", "livemap")
        {
            HelpText = Text.T("Panel map status. Usage: /map [regenerate]", "Stato della mappa del pannello. Uso: /mappa [rigenera]"),
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
            _engine?.Dispose();
            _engine = null;
            _tileFramed = _wallFramed = null;
        }
        base.Dispose(disposing);
    }

    private void OnWorldReady(EventArgs args)
    {
        if (!PrepareColors()) return;
        _tileFramed = new BitArray(Main.maxTilesX * Main.maxTilesY);
        _wallFramed = new BitArray(Main.maxTilesX * Main.maxTilesY);
        var config = Config.Load(ConfigPath);
        _engine = new MapEngine(MapDir, config, Main.maxTilesX, Main.maxTilesY, Pixel, World, Players, ReadTile, Types());
        Log.Info(Text.T($"Map ready: {_engine.Cols}×{_engine.Rows} chunks in {MapDir}", $"Mappa pronta: {_engine.Cols}×{_engine.Rows} riquadri in {MapDir}") +
                 (config.SempreAttiva
                     ? Text.T(" (always active)", " (sempre attiva)")
                     : Text.T(" (updated when the panel opens it)", " (si aggiorna quando il pannello la apre)")));
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
            Pixel(Main.spawnTileX, Main.spawnTileY);
            return true;
        }
        catch (Exception ex)
        {
            Log.Error(Text.T($"The map colors are not available on this server, plugin disabled: {ex}", $"I colori della mappa non sono disponibili su questo server, plugin disattivato: {ex}"));
            return false;
        }
    }

    private static int Pixel(int x, int y)
    {
        EnsureFramed(x, y);
        var color = MapHelper.GetMapTileXnaColor(MapHelper.CreateMapTile(x, y, 255), x, y);
        return color.R << 16 | color.G << 8 | color.B;
    }

    /// <summary>
    /// Frame della tile (quale parte del foglio di sprite usare): caricando il mondo il gioco li tiene solo per i blocchi
    /// "frame important" (mobili, oggetti di più tile) e li lascia da calcolare ai client. In Terraria 1.4.5 la scelta
    /// del frame è WorldGen.TileFrameCosmetic, separata dagli effetti di TileFrame (sabbia che cade, liane, cactus,
    /// liquidi): si chiama direttamente quella, e Framing.WallFrame per i muri. Una volta per tile a ogni avvio; dopo,
    /// se cambiano, li ricalcola il gioco.
    /// </summary>
    private static void EnsureFramed(int x, int y)
    {
        var t = Main.tile[x, y];
        var index = y * Main.maxTilesX + x;
        if (t.active() && !Main.tileFrameImportant[t.type] && _tileFramed is { } tiles && !tiles[index])
        {
            WorldGen.TileFrameCosmetic(x, y, t, true);
            tiles[index] = true;
        }
        if (t.wall > 0 && _wallFramed is { } walls && !walls[index])
        {
            Framing.WallFrame(x, y, true);
            walls[index] = true;
        }
    }

    /// <summary>Dati grezzi della tile, per gli sprite nel pannello (TileData).</summary>
    private static void ReadTile(int x, int y, Span<byte> dest)
    {
        var t = Main.tile[x, y];
        var shape = t.halfBrick() ? 1 : t.slope() == 0 ? 0 : t.slope() + 1;
        var wallFramed = t.wall > 0 && _wallFramed?[y * Main.maxTilesX + x] == true;
        TileData.Write(dest, t.active(), t.type, t.frameX, t.frameY, t.wall, shape, t.inActive(), t.liquidType(), t.liquid,
            t.color(), wallFramed ? t.wallFrameX() : -1, wallFramed ? t.wallFrameY() : -1, t.wallColor(),
            (t.fullbrightBlock() ? TileData.TileGlow : 0) | (t.fullbrightWall() ? TileData.WallGlow : 0)
            | (t.invisibleBlock() ? TileData.TileEcho : 0) | (t.invisibleWall() ? TileData.WallEcho : 0));
    }

    /// <summary>Tipi di blocchi e muri (solo quelli di Terraria: TShock non ha mod).</summary>
    private static TileTypes Types() => new()
    {
        VanillaTiles = TileID.Count,
        VanillaWalls = WallID.Count,
        FrameImportant = Main.tileFrameImportant.Take(TileID.Count).ToArray(),
        Solid = Main.tileSolid.Take(TileID.Count).ToArray(),
    };

    private void OnUpdate(EventArgs args) => _engine?.OnGameUpdate();

    private void OnSendData(SendDataEventArgs e) => _engine?.OnSendData((int)e.MsgId, e.number, e.number2, e.number3, e.number4);

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
        if (_engine == null)
        {
            player.SendErrorMessage(Text.T("[LiveMap] The map is not active (world not loaded yet or colors not available).", "[LiveMap] La mappa non è attiva (mondo non ancora caricato o colori non disponibili)."));
            return;
        }

        if (args.Parameters.Count > 0 && args.Parameters[0].ToLowerInvariant() is "rigenera" or "regenerate")
        {
            _engine.Regenerate();
            player.SendSuccessMessage(Text.T("[LiveMap] The map will be redrawn from scratch.", "[LiveMap] La mappa verrà ridisegnata da capo."));
            return;
        }
        foreach (var line in _engine.Status()) player.SendInfoMessage($"[LiveMap] {line}");
    }

    private void OnReload(ReloadEventArgs args)
    {
        if (_engine != null) _engine.Config = Config.Load(ConfigPath);
        args.Player.SendSuccessMessage(Text.T("[LiveMap] Configuration reloaded (ScalaPanoramica applies from the next restart).", "[LiveMap] Configurazione ricaricata (ScalaPanoramica vale dal prossimo riavvio)."));
    }
}

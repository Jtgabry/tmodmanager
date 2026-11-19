using Terraria;
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
    public override Version Version => new(1, 1, 0);
    public override string Author => "tModManager";
    public override string Description => "Mappa del mondo in tempo reale per il pannello di tModManager.";

    private static string ConfigPath => Path.Combine(TShock.SavePath, "LiveMap.json");
    private static string MapDir => Path.Combine(TShock.SavePath, "map");

    private Command? _command;
    private MapEngine? _engine;

    public LiveMap(Main game) : base(game) { }

    public override void Initialize()
    {
        Log.Info = message => TShock.Log.ConsoleInfo($"[LiveMap] {message}");
        Log.Warn = message => TShock.Log.ConsoleWarn($"[LiveMap] {message}");
        Log.Error = message => TShock.Log.ConsoleError($"[LiveMap] {message}");
        Directory.CreateDirectory(MapDir);

        _command = new Command("livemap.admin", MapCommand, "mappa", "livemap")
        {
            HelpText = "Stato della mappa del pannello. Uso: /mappa [rigenera]",
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
        }
        base.Dispose(disposing);
    }

    private void OnWorldReady(EventArgs args)
    {
        if (!PrepareColors()) return;
        var config = Config.Load(ConfigPath);
        _engine = new MapEngine(MapDir, config, Main.maxTilesX, Main.maxTilesY, Pixel, World, Players);
        Log.Info($"Mappa pronta: {_engine.Cols}×{_engine.Rows} riquadri in {MapDir}" +
                 (config.SempreAttiva ? " (sempre attiva)" : " (si aggiorna quando il pannello la apre)"));
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
            Log.Error($"I colori della mappa non sono disponibili su questo server, plugin disattivato: {ex}");
            return false;
        }
    }

    private static int Pixel(int x, int y)
    {
        var color = MapHelper.GetMapTileXnaColor(MapHelper.CreateMapTile(x, y, 255), x, y);
        return color.R << 16 | color.G << 8 | color.B;
    }

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
            player.SendErrorMessage("[LiveMap] La mappa non è attiva (mondo non ancora caricato o colori non disponibili).");
            return;
        }

        if (args.Parameters.Count > 0 && args.Parameters[0].Equals("rigenera", StringComparison.OrdinalIgnoreCase))
        {
            _engine.Regenerate();
            player.SendSuccessMessage("[LiveMap] La mappa verrà ridisegnata da capo.");
            return;
        }
        foreach (var line in _engine.Status()) player.SendInfoMessage($"[LiveMap] {line}");
    }

    private void OnReload(ReloadEventArgs args)
    {
        if (_engine != null) _engine.Config = Config.Load(ConfigPath);
        args.Player.SendSuccessMessage("[LiveMap] Configurazione ricaricata (ScalaPanoramica vale dal prossimo riavvio).");
    }
}

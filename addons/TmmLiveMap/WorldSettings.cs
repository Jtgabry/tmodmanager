using Terraria;
using Terraria.GameContent.Events;
using Terraria.ID;

namespace TmmLiveMap;

/// <summary>
/// Settaggi del mondo per l'editor del pannello: ora, meteo, eventi, luna, difficoltà, hardmode, spawn, boss
/// sconfitti. Si leggono (<see cref="Read"/>, in editor/world.json) e si cambiano (<see cref="Apply"/>, dal thread
/// di gioco); ai client va poi il pacchetto WorldData, come fa il gioco quando cambiano.
/// </summary>
public static class WorldSettings
{
    /// <summary>Boss di Terraria: nome per il pannello → campo di NPC (downed…).</summary>
    private static readonly (string Key, Func<bool> Get, Action<bool> Set)[] Bosses =
    [
        ("slimeKing", () => NPC.downedSlimeKing, v => NPC.downedSlimeKing = v),
        ("eyeOfCthulhu", () => NPC.downedBoss1, v => NPC.downedBoss1 = v),
        ("evilBoss", () => NPC.downedBoss2, v => NPC.downedBoss2 = v),
        ("queenBee", () => NPC.downedQueenBee, v => NPC.downedQueenBee = v),
        ("skeletron", () => NPC.downedBoss3, v => NPC.downedBoss3 = v),
        ("deerclops", () => NPC.downedDeerclops, v => NPC.downedDeerclops = v),
        ("wallOfFlesh", () => Main.hardMode, _ => { }), // si cambia con hardMode
        ("queenSlime", () => NPC.downedQueenSlime, v => NPC.downedQueenSlime = v),
        ("destroyer", () => NPC.downedMechBoss1, v => NPC.downedMechBoss1 = v),
        ("twins", () => NPC.downedMechBoss2, v => NPC.downedMechBoss2 = v),
        ("skeletronPrime", () => NPC.downedMechBoss3, v => NPC.downedMechBoss3 = v),
        ("plantera", () => NPC.downedPlantBoss, v => NPC.downedPlantBoss = v),
        ("golem", () => NPC.downedGolemBoss, v => NPC.downedGolemBoss = v),
        ("dukeFishron", () => NPC.downedFishron, v => NPC.downedFishron = v),
        ("empressOfLight", () => NPC.downedEmpressOfLight, v => NPC.downedEmpressOfLight = v),
        ("lunaticCultist", () => NPC.downedAncientCultist, v => NPC.downedAncientCultist = v),
        ("moonLord", () => NPC.downedMoonlord, v => NPC.downedMoonlord = v),
    ];

    /// <summary>Alba (4:30) e tramonto (19:30) in minuti dalla mezzanotte: il giorno di Terraria va dall'una all'altro.</summary>
    private const int DawnMinutes = 270, DuskMinutes = 1170;

    public sealed class State
    {
        /// <summary>Ora del mondo, in minuti dalla mezzanotte (0–1439).</summary>
        public int Clock { get; set; }
        public bool Day { get; set; }
        public bool Rain { get; set; }
        public bool Sandstorm { get; set; }
        public bool BloodMoon { get; set; }
        public bool Eclipse { get; set; }
        /// <summary>0 = luna piena … 4 = luna nuova … 7.</summary>
        public int MoonPhase { get; set; }
        /// <summary>0 classica, 1 esperto, 2 maestro, 3 viaggio.</summary>
        public int GameMode { get; set; }
        public bool HardMode { get; set; }
        /// <summary>Hardmode appena attivato: il gioco sta ancora generando le strisce di consacrato e corruzione/cremisi.</summary>
        public bool GeneratingHardMode { get; set; }
        public int SpawnX { get; set; }
        public int SpawnY { get; set; }
        public Dictionary<string, bool> Bosses { get; set; } = [];
    }

    /// <summary>Cosa cambiare: i campi null restano come sono.</summary>
    public sealed class Changes
    {
        public int? Clock { get; set; }
        public bool? Rain { get; set; }
        public bool? Sandstorm { get; set; }
        public bool? BloodMoon { get; set; }
        public bool? Eclipse { get; set; }
        public int? MoonPhase { get; set; }
        public int? GameMode { get; set; }
        public bool? HardMode { get; set; }
        public int? SpawnX { get; set; }
        public int? SpawnY { get; set; }
        public Dictionary<string, bool>? Bosses { get; set; }
    }

    public static State Read()
    {
        var minutes = (int)(Main.time / 60);
        return new State
        {
            Clock = ((Main.dayTime ? DawnMinutes : DuskMinutes) + minutes) % 1440,
            Day = Main.dayTime,
            Rain = Main.raining,
            Sandstorm = Sandstorm.Happening,
            BloodMoon = Main.bloodMoon,
            Eclipse = Main.eclipse,
            MoonPhase = Main.moonPhase,
            GameMode = Main.GameMode,
            HardMode = Main.hardMode,
            GeneratingHardMode = WorldGen.IsGeneratingHardMode,
            SpawnX = Main.spawnTileX,
            SpawnY = Main.spawnTileY,
            Bosses = Bosses.ToDictionary(b => b.Key, b => b.Get()),
        };
    }

    /// <summary>Applica i cambiamenti, nell'ordine giusto (prima l'ora: luna di sangue ed eclissi dipendono da lei). Restituisce chiave → motivo dei non riusciti.</summary>
    public static List<(string Key, string Reason)> Apply(Changes changes)
    {
        var failures = new List<(string, string)>();

        if (changes.Clock is { } clock)
        {
            if (clock is < 0 or >= 1440)
            {
                failures.Add(("clock", "ora non valida"));
            }
            else
            {
                var day = clock >= DawnMinutes && clock < DuskMinutes;
                Main.dayTime = day;
                Main.time = ((clock - (day ? DawnMinutes : DuskMinutes) + 1440) % 1440) * 60.0;
                // Come al passaggio naturale tra giorno e notte: la luna di sangue finisce all'alba, l'eclissi al tramonto
                if (day) Main.bloodMoon = false;
                else Main.eclipse = false;
            }
        }

        if (changes.Rain is { } rain)
        {
            if (rain && !Main.raining) Main.StartRain();
            else if (!rain && Main.raining) Main.StopRain();
        }

        if (changes.Sandstorm is { } sandstorm)
        {
            if (sandstorm && !Sandstorm.Happening) Sandstorm.StartSandstorm();
            else if (!sandstorm && Sandstorm.Happening) Sandstorm.StopSandstorm();
        }

        if (changes.BloodMoon is { } bloodMoon)
        {
            if (bloodMoon && Main.dayTime) failures.Add(("bloodMoon", "solo di notte"));
            else Main.bloodMoon = bloodMoon;
        }

        if (changes.Eclipse is { } eclipse)
        {
            if (eclipse && !Main.dayTime) failures.Add(("eclipse", "solo di giorno"));
            else Main.eclipse = eclipse;
        }

        if (changes.MoonPhase is { } phase)
        {
            if (phase is < 0 or > 7) failures.Add(("moonPhase", "fase non valida"));
            else Main.moonPhase = phase;
        }

        if (changes.GameMode is { } mode && mode != Main.GameMode)
        {
            // Viaggio: i personaggi devono essere di quel tipo, e i suoi poteri hanno uno stato a parte
            if (mode is < 0 or > 2) failures.Add(("gameMode", "difficoltà non valida"));
            else if (Main.GameMode == GameModeID.Creative) failures.Add(("gameMode", "un mondo Viaggio non si cambia"));
            else
            {
                Main.GameMode = mode;
                if (Main.ActiveWorldFileData is { } data) data.GameMode = mode;
            }
        }

        if (changes.HardMode is { } hardMode && hardMode != Main.hardMode)
        {
            // Come uccidere il Muro di carne: genera le strisce di consacrato e corruzione/cremisi (non si tolgono più)
            if (hardMode) WorldGen.StartHardmode();
            else Main.hardMode = false;
        }

        if (changes.SpawnX is { } x && changes.SpawnY is { } y)
        {
            if (x < 10 || y < 10 || x >= Main.maxTilesX - 10 || y >= Main.maxTilesY - 10) failures.Add(("spawn", "fuori dal mondo"));
            else (Main.spawnTileX, Main.spawnTileY) = (x, y);
        }

        if (changes.Bosses is { } bosses)
        {
            foreach (var (key, value) in bosses)
            {
                var boss = Bosses.FirstOrDefault(b => b.Key == key);
                if (boss.Key == null) failures.Add(($"bosses.{key}", "boss sconosciuto"));
                else if (key == "wallOfFlesh") failures.Add(($"bosses.{key}", "si cambia con l'hardmode"));
                else boss.Set(value);
            }
            NPC.downedMechBossAny = NPC.downedMechBoss1 || NPC.downedMechBoss2 || NPC.downedMechBoss3;
        }

        if (Main.netMode == NetmodeID.Server) NetMessage.SendData(MessageID.WorldData);
        return failures;
    }
}

using System.Text.Json;

namespace TmmLiveMap;

/// <summary>Configurazione (creata al primo avvio): tshock/LiveMap.json con TShock, LiveMap/config.json con tModLoader.</summary>
public class Config
{
    /// <summary>Aggiorna la mappa anche quando nessuno la guarda dal pannello (utile per provarla senza pannello).</summary>
    public bool SempreAttiva { get; set; } = false;

    /// <summary>Dopo quanti secondi senza spettatori la mappa smette di aggiornarsi.</summary>
    public int SecondiSenzaSpettatori { get; set; } = 120;

    /// <summary>Tempo massimo per tick (1/60 s) che il disegno può togliere al server.</summary>
    public double MillisecondiPerTick { get; set; } = 1.0;

    /// <summary>
    /// Ogni quanto un riquadro viene riletto comunque, per le modifiche che il server non comunica ai client
    /// (rare: quasi tutto arriva già dagli hook di rete).
    /// </summary>
    public int MinutiTraRiletture { get; set; } = 15;

    /// <summary>Attesa dopo l'ultima modifica prima di ridisegnare un riquadro (raggruppa gli scavi a raffica).</summary>
    public int MillisecondiAttesaModifiche { get; set; } = 1000;

    /// <summary>Ogni quanti secondi si aggiornano le posizioni dei giocatori.</summary>
    public double SecondiGiocatori { get; set; } = 1;

    /// <summary>Riduzione della panoramica (immagine unica del mondo intero): 4 = un pixel ogni 4×4 tile.</summary>
    public int ScalaPanoramica { get; set; } = 4;

    private static readonly JsonSerializerOptions Options = new() { WriteIndented = true };

    public static Config Load(string path)
    {
        Config config;
        try
        {
            config = File.Exists(path)
                ? JsonSerializer.Deserialize<Config>(File.ReadAllText(path), Options) ?? new Config()
                : new Config();
        }
        catch (Exception ex)
        {
            Log.Error(Text.T($"{path} is not valid, using the default values: {ex.Message}", $"{path} non valido, uso i valori di default: {ex.Message}"));
            return new Config();
        }

        config.SecondiSenzaSpettatori = Math.Max(10, config.SecondiSenzaSpettatori);
        config.MillisecondiPerTick = Math.Clamp(config.MillisecondiPerTick, 0.1, 8);
        config.MinutiTraRiletture = Math.Max(1, config.MinutiTraRiletture);
        config.MillisecondiAttesaModifiche = Math.Clamp(config.MillisecondiAttesaModifiche, 0, 60_000);
        config.SecondiGiocatori = Math.Clamp(config.SecondiGiocatori, 0.25, 60);
        config.ScalaPanoramica = Math.Clamp(config.ScalaPanoramica, 1, 16);

        try
        {
            if (!File.Exists(path)) File.WriteAllText(path, JsonSerializer.Serialize(config, Options));
        }
        catch (Exception ex)
        {
            Log.Warn(Text.T($"{path} could not be created: {ex.Message}", $"{path} non si è potuto creare: {ex.Message}"));
        }
        return config;
    }
}

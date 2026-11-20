namespace TmmLiveMap;

/// <summary>
/// Lingua dei messaggi nella console del server: quella del server (chiave language di serverconfig, cambiabile
/// dal pannello). Italiano se è it-*, altrimenti inglese come il pannello. Ogni host collega la sua lingua.
/// </summary>
public static class Text
{
    public static Func<string> Culture = () => "en-US";

    /// <summary>Il testo nella lingua del server: inglese oppure italiano.</summary>
    public static string T(string english, string italian) =>
        Culture().StartsWith("it", StringComparison.OrdinalIgnoreCase) ? italian : english;
}

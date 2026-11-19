namespace TmmLiveMap;

/// <summary>Messaggi nella console del server: ogni host (plugin TShock, mod tModLoader) collega i suoi.</summary>
public static class Log
{
    public static Action<string> Info = message => Console.WriteLine($"[LiveMap] {message}");
    public static Action<string> Warn = message => Console.WriteLine($"[LiveMap] {message}");
    public static Action<string> Error = message => Console.Error.WriteLine($"[LiveMap] {message}");
}

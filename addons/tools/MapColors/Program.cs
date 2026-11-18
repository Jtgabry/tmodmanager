using System.Text.Json;
using Terraria.Map;

// Tabelle dei colori della minimappa di Terraria, per disegnare la mappa dai file del mondo (.wld) senza
// avere Terraria: l'agent le legge da map-colors.json. Si ricavano chiamando MapHelper.Initialize(), lo
// stesso codice che usa il gioco, così restano giuste a ogni versione di Terraria.
//   dotnet run --project tools/MapColors -- <file di uscita>

var output = args.Length > 0 ? args[0] : "map-colors.json";

// Terraria tiene alcune librerie (es. Ionic.Zip.CF) come risorse incorporate e le carica quando servono:
// qui si fa lo stesso, altrimenti MapHelper non si inizializza
System.Runtime.Loader.AssemblyLoadContext.Default.Resolving += (context, name) =>
{
    var terraria = typeof(MapHelper).Assembly;
    var resource = terraria.GetManifestResourceNames().FirstOrDefault(r => r.EndsWith($".{name.Name}.dll", StringComparison.Ordinal));
    if (resource == null) return null;
    using var stream = terraria.GetManifestResourceStream(resource)!;
    return context.LoadFromStream(stream);
};

try
{
    MapHelper.Initialize();
}
catch (Exception ex) when (MapHelper.colorLookup is { Length: > 0 })
{
    // In fondo Initialize prepara i nomi della mappa (Lang.BuildMapAtlas), che senza le lingue del gioco
    // falliscono: i colori a quel punto sono già pronti
    Console.Error.WriteLine($"Nomi della mappa non disponibili ({ex.GetType().Name}): servono solo i colori");
}

var data = new
{
    format = 1,
    terraria = typeof(MapHelper).Assembly.GetName().Version?.ToString(),
    // 0xRRGGBB per ogni voce della tabella
    colors = MapHelper.colorLookup.Select(c => c.R << 16 | c.G << 8 | c.B).ToArray(),
    tileLookup = MapHelper.tileLookup,
    tileOptionCounts = MapHelper.tileOptionCounts,
    wallLookup = MapHelper.wallLookup,
    wallOptionCounts = MapHelper.wallOptionCounts,
    liquidPosition = MapHelper.liquidPosition,
    skyPosition = MapHelper.skyPosition,
    dirtPosition = MapHelper.dirtPosition,
    rockPosition = MapHelper.rockPosition,
    hellPosition = MapHelper.hellPosition,
    maxSkyGradients = MapHelper.maxSkyGradients,
    maxDirtGradients = MapHelper.maxDirtGradients,
    maxRockGradients = MapHelper.maxRockGradients,
};

File.WriteAllText(output, JsonSerializer.Serialize(data));
Console.WriteLine($"{output}: {data.colors.Length} colori, {data.tileLookup.Length} blocchi, {data.wallLookup.Length} muri");

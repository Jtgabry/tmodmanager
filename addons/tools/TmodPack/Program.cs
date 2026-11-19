using System.IO.Compression;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

// Crea il .tmod di una mod già compilata, come fa tModLoader con "-build", ma senza avviare tModLoader:
//   TmodPack <cartella della mod> <Nome.dll> <tModLoader.dll> <uscita.tmod>
//
// Formato (tModLoader 1.4, TmodFile.Save):
//   "TMOD" · versione di tModLoader · SHA1(20) dei dati · firma(256, vuota) · lunghezza dei dati (u32)
//   dati: nome · versione · n. file (i32) · [percorso, lunghezza, lunghezza compressa]… · contenuti
// Il file "Info" contiene le build properties (BuildProperties.ToBytes), ricavate da build.txt.

if (args.Length != 4)
{
    Console.Error.WriteLine("Uso: TmodPack <cartella della mod> <Nome.dll> <tModLoader.dll> <uscita.tmod>");
    return 2;
}
var (modDir, dllPath, tmlPath, output) = (args[0], args[1], args[2], args[3]);

try
{
    var name = Path.GetFileNameWithoutExtension(dllPath);
    if (!Regex.IsMatch(name, "^[A-Za-z0-9_]+$")) throw new Exception($"Nome della mod non valido: {name}");
    var props = BuildTxt.Read(Path.Combine(modDir, "build.txt"));
    var tmlVersion = TmlVersion(tmlPath);
    var description = File.Exists(Path.Combine(modDir, "description.txt")) ? File.ReadAllText(Path.Combine(modDir, "description.txt")) : "";

    var files = new List<(string Path, byte[] Data)>
    {
        ("Info", props.ToBytes(description, tmlVersion)),
        ($"{name}.dll", File.ReadAllBytes(dllPath)),
    };
    var pdb = Path.ChangeExtension(dllPath, ".pdb");
    if (File.Exists(pdb)) files.Add(($"{name}.pdb", File.ReadAllBytes(pdb)));
    var icon = Path.Combine(modDir, "icon.png");
    if (File.Exists(icon)) files.Add(("icon.png", File.ReadAllBytes(icon)));
    // Traduzioni (Localization/*.hjson), se ci sono
    var localization = Path.Combine(modDir, "Localization");
    if (Directory.Exists(localization))
        foreach (var file in Directory.EnumerateFiles(localization, "*.hjson", SearchOption.AllDirectories).Order())
            files.Add((Path.GetRelativePath(modDir, file).Replace('\\', '/'), File.ReadAllBytes(file)));

    Write(output, name, props.Version, tmlVersion, files);
    Console.WriteLine($"{output} ({name} {props.Version}, tModLoader {tmlVersion})");
    return 0;
}
catch (Exception ex)
{
    Console.Error.WriteLine($"TmodPack: {ex.Message}");
    return 1;
}

static void Write(string output, string name, string version, string tmlVersion, List<(string Path, byte[] Data)> files)
{
    // Come tModLoader: compressi (deflate) solo se conviene, mai le immagini e i suoni
    var stored = files.Select(f =>
    {
        if (f.Path.EndsWith(".png") || f.Path.EndsWith(".mp3") || f.Path.EndsWith(".ogg")) return (f.Path, f.Data.Length, f.Data);
        using var ms = new MemoryStream();
        using (var deflate = new DeflateStream(ms, CompressionLevel.SmallestSize, leaveOpen: true)) deflate.Write(f.Data);
        var compressed = ms.ToArray();
        return compressed.Length < f.Data.Length * 0.9 ? (f.Path, f.Data.Length, compressed) : (f.Path, f.Data.Length, f.Data);
    }).ToList();

    using var data = new MemoryStream();
    using (var w = new BinaryWriter(data, System.Text.Encoding.UTF8, leaveOpen: true))
    {
        w.Write(name);
        w.Write(version);
        w.Write(stored.Count);
        foreach (var (path, length, bytes) in stored)
        {
            w.Write(path);
            w.Write(length);
            w.Write(bytes.Length);
        }
        foreach (var (_, _, bytes) in stored) w.Write(bytes);
    }
    var body = data.ToArray();

    Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output))!);
    var tmp = output + ".tmp";
    using (var file = File.Create(tmp))
    using (var w = new BinaryWriter(file))
    {
        w.Write("TMOD"u8);
        w.Write(tmlVersion);
        w.Write(SHA1.HashData(body));
        w.Write(new byte[256]); // firma: solo le mod pubblicate nel browser di tModLoader ce l'hanno
        w.Write((uint)body.Length);
        w.Write(body);
    }
    File.Move(tmp, output, overwrite: true);
}

/// <summary>Versione di tModLoader (es. 2026.8.3.0) dall'AssemblyInformationalVersion di tModLoader.dll.</summary>
static string TmlVersion(string tmlDll)
{
    using var pe = new PEReader(File.OpenRead(tmlDll));
    var md = pe.GetMetadataReader();
    foreach (var handle in md.GetAssemblyDefinition().GetCustomAttributes())
    {
        var attr = md.GetCustomAttribute(handle);
        if (attr.Constructor.Kind != HandleKind.MemberReference) continue;
        var parent = md.GetMemberReference((MemberReferenceHandle)attr.Constructor).Parent;
        if (parent.Kind != HandleKind.TypeReference || md.GetString(md.GetTypeReference((TypeReferenceHandle)parent).Name) != "AssemblyInformationalVersionAttribute") continue;
        var blob = md.GetBlobReader(attr.Value);
        blob.ReadUInt16(); // prologo
        var text = blob.ReadSerializedString() ?? "";
        // "1.4.4.9+2026.08.3.0|2026.08|stable|…" (Terraria+tModLoader): come Version.ToString() di tModLoader,
        // senza zeri iniziali
        var tml = text.Contains('+') ? text[(text.IndexOf('+') + 1)..] : text;
        if (Version.TryParse(tml.Split('|')[0], out var v)) return v.ToString();
    }
    throw new Exception($"Versione di tModLoader non trovata in {tmlDll}");
}

/// <summary>build.txt della mod: "chiave = valore" per riga, come quello di tModLoader (solo le chiavi usate qui).</summary>
sealed class BuildTxt
{
    public string Version = "1.0";
    public string DisplayName = "", Author = "", Homepage = "";
    public byte Side; // 0 Both, 1 Client, 2 Server, 3 NoSync
    public string[] ModReferences = [], WeakReferences = [], SortAfter = [], SortBefore = [];
    public bool HideCode, HideResources;

    public static BuildTxt Read(string path)
    {
        var p = new BuildTxt();
        foreach (var raw in File.ReadAllLines(path))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#')) continue;
            var eq = line.IndexOf('=');
            if (eq < 0) throw new Exception($"build.txt: riga non valida \"{line}\"");
            var key = line[..eq].Trim();
            var value = line[(eq + 1)..].Trim();
            string[] List() => value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            switch (key)
            {
                case "version": p.Version = System.Version.Parse(value).ToString(); break;
                case "displayName": p.DisplayName = value; break;
                case "author": p.Author = value; break;
                case "homepage": p.Homepage = value; break;
                case "side":
                    p.Side = value switch
                    {
                        "Both" => 0, "Client" => 1, "Server" => 2, "NoSync" => 3,
                        _ => throw new Exception($"build.txt: side \"{value}\" non valido (Both, Client, Server, NoSync)"),
                    };
                    break;
                case "modReferences": p.ModReferences = List(); break;
                case "weakReferences": p.WeakReferences = List(); break;
                case "sortAfter": p.SortAfter = List(); break;
                case "sortBefore": p.SortBefore = List(); break;
                case "hideCode": p.HideCode = bool.Parse(value); break;
                case "hideResources": p.HideResources = bool.Parse(value); break;
                default: throw new Exception($"build.txt: chiave \"{key}\" non supportata da TmodPack");
            }
        }
        return p;
    }

    /// <summary>Come BuildProperties.ToBytes di tModLoader: tag, valore, e una stringa vuota alla fine.</summary>
    public byte[] ToBytes(string description, string buildVersion)
    {
        using var ms = new MemoryStream();
        using (var w = new BinaryWriter(ms))
        {
            void ListTag(string tag, string[] items)
            {
                if (items.Length == 0) return;
                w.Write(tag);
                foreach (var item in items) w.Write(item);
                w.Write("");
            }
            void StringTag(string tag, string value)
            {
                if (value.Length == 0) return;
                w.Write(tag);
                w.Write(value);
            }
            ListTag("modReferences", ModReferences);
            ListTag("weakReferences", WeakReferences);
            ListTag("sortAfter", SortAfter);
            ListTag("sortBefore", SortBefore);
            StringTag("author", Author);
            w.Write("version");
            w.Write(Version);
            StringTag("displayName", DisplayName);
            StringTag("homepage", Homepage);
            StringTag("description", description);
            if (!HideCode) w.Write("!hideCode");
            if (!HideResources) w.Write("!hideResources");
            if (Side != 0)
            {
                w.Write("side");
                w.Write(Side);
            }
            w.Write("buildVersion");
            w.Write(buildVersion);
            w.Write("");
        }
        return ms.ToArray();
    }
}

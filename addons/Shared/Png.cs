using System.Buffers.Binary;
using System.IO.Compression;

namespace TmmLiveMap;

/// <summary>Encoder PNG minimo (RGB 8 bit, filtro Sub): .NET su Linux non ne ha uno incluso.</summary>
public static class Png
{
    private static readonly byte[] Signature = [0x89, (byte)'P', (byte)'N', (byte)'G', 0x0D, 0x0A, 0x1A, 0x0A];
    private static readonly uint[] CrcTable = BuildCrcTable();

    /// <summary>Scrive un'immagine da pixel 0xRRGGBB (riga per riga, <paramref name="stride"/> pixel per riga).</summary>
    public static void Write(string path, int[] pixels, int width, int height, int stride)
    {
        var tmp = path + ".tmp";
        using (var file = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16))
        {
            file.Write(Signature);

            var header = new byte[13];
            BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(0), width);
            BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(4), height);
            header[8] = 8; // bit per canale
            header[9] = 2; // RGB
            WriteChunk(file, "IHDR", header);

            using var data = new MemoryStream();
            using (var zlib = new ZLibStream(data, CompressionLevel.Optimal, leaveOpen: true))
            {
                var row = new byte[1 + width * 3];
                row[0] = 1; // filtro Sub: ogni byte meno quello del pixel a sinistra (cielo e pietra → zeri)
                for (var y = 0; y < height; y++)
                {
                    int prev = 0, offset = y * stride;
                    for (var x = 0; x < width; x++)
                    {
                        var p = pixels[offset + x];
                        var i = 1 + x * 3;
                        row[i] = (byte)((p >> 16) - (prev >> 16));
                        row[i + 1] = (byte)((p >> 8) - (prev >> 8));
                        row[i + 2] = (byte)(p - prev);
                        prev = p;
                    }
                    zlib.Write(row);
                }
            }
            WriteChunk(file, "IDAT", data.GetBuffer().AsSpan(0, (int)data.Length));
            WriteChunk(file, "IEND", []);
        }
        File.Move(tmp, path, overwrite: true); // chi legge vede sempre un file completo
    }

    private static void WriteChunk(Stream stream, string type, ReadOnlySpan<byte> data)
    {
        Span<byte> buf = stackalloc byte[4];
        BinaryPrimitives.WriteInt32BigEndian(buf, data.Length);
        stream.Write(buf);

        Span<byte> typeBytes = stackalloc byte[4];
        for (var i = 0; i < 4; i++) typeBytes[i] = (byte)type[i];
        stream.Write(typeBytes);
        stream.Write(data);

        var crc = Crc(Crc(0xFFFFFFFF, typeBytes), data) ^ 0xFFFFFFFF;
        BinaryPrimitives.WriteUInt32BigEndian(buf, crc);
        stream.Write(buf);
    }

    private static uint Crc(uint crc, ReadOnlySpan<byte> data)
    {
        foreach (var b in data) crc = CrcTable[(crc ^ b) & 0xFF] ^ (crc >> 8);
        return crc;
    }

    private static uint[] BuildCrcTable()
    {
        var table = new uint[256];
        for (uint n = 0; n < 256; n++)
        {
            var c = n;
            for (var k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
            table[n] = c;
        }
        return table;
    }
}

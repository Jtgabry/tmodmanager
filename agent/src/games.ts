import { open, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * I tipi di server: Terraria vanilla (dedicated server di Re-Logic), TShock (server vanilla con plugin,
 * i giocatori entrano con Terraria normale) e tModLoader. Un server usa un'installazione di uno dei tre;
 * si può passare dall'uno all'altro tenendo lo stesso mondo.
 */
export const GAMES = ['terraria', 'tshock', 'tmodloader'] as const
export type Game = (typeof GAMES)[number]

const LABELS: Record<Game, string> = { terraria: 'Terraria', tshock: 'TShock', tmodloader: 'tModLoader' }
export const gameLabel = (game: Game) => LABELS[game]

/** File che identificano un'installazione. */
export const TERRARIA_BINARY = 'TerrariaServer.bin.x86_64'
export const TERRARIA_ASSEMBLY = 'TerrariaServer.exe'
export const TML_ASSEMBLY = 'tModLoader.dll'
export const TML_START_SCRIPT = 'start-tModLoaderServer.sh'
export const TSHOCK_BINARY = 'TShock.Server'
/** Assembly di TShock (la sua versione) e Terraria modificato da OTAPI (la versione di Terraria). */
export const TSHOCK_ASSEMBLY = join('ServerPlugins', 'TShockAPI.dll')
export const TSHOCK_GAME_ASSEMBLY = join('bin', 'OTAPI.dll')

/** Cartelle di TShock dentro il save/ del server: restano lì anche passando a vanilla o tModLoader. */
export const tshockDataDir = (saveDir: string) => join(saveDir, 'tshock')
export const tshockPluginsDir = (saveDir: string) => join(saveDir, 'ServerPlugins')

/**
 * Versione di Terraria → numero di versione scritto nei mondi (primi 4 byte del .wld).
 * Fonte: TEdit, src/TEdit.Terraria/Data/versions.json. Le versioni non in tabella si imparano
 * leggendo i mondi salvati dai server (vedi recordWorldRelease in tml.ts).
 */
export const WORLD_RELEASES: Record<string, number> = {
  '1.4.4.9': 279,
  '1.4.5.0': 315,
  '1.4.5.1': 315,
  '1.4.5.2': 315,
  '1.4.5.3': 316,
  '1.4.5.4': 317,
  '1.4.5.5': 318,
  '1.4.5.6': 319,
  '1.4.5.7': 325,
  '1.4.5.8': 326,
}

/** Numero di versione del mondo (int32 little endian all'inizio del .wld); null se il file non c'è o non è un mondo. */
export async function readWorldRelease(path: string): Promise<number | null> {
  try {
    const file = await open(path)
    try {
      const { buffer, bytesRead } = await file.read({ buffer: Buffer.alloc(24) })
      if (bytesRead < 24) return null
      const release = buffer.readInt32LE(0)
      // Dalla 1.3 in poi c'è la firma "relogic" subito dopo
      if (buffer.toString('latin1', 4, 11) !== 'relogic') return null
      return release > 0 && release < 100_000 ? release : null
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

/** "1458" (nome dello zip di terraria.org) → "1.4.5.8"; "14481" → "1.4.4.8.1". */
export function terrariaVersionFromCode(code: string): string | null {
  return /^1\d{3,5}$/.test(code) ? code.split('').join('.') : null
}

/** "1.4.5.8" → "1458". Solo versioni a cifre singole (come le usa terraria.org). */
export function terrariaCode(version: string): string | null {
  return /^1(\.\d){3,5}$/.test(version) ? version.replaceAll('.', '') : null
}

/** Confronto tra versioni "1.4.5.8" / "2026.09.3.1" (numerico per parti). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * Versione di Terraria di un assembly .NET, dal campo FileVersion delle sue informazioni di versione
 * (risorsa VERSIONINFO, stringhe UTF-16): "1.4.5.8" per TerrariaServer.exe, "1.4.4.9" per tModLoader.dll
 * (la versione di Terraria su cui è basato). Altre stringhe di versione nell'assembly non contano.
 */
export function scanGameVersion(assembly: Buffer): string | null {
  const key = Buffer.from('FileVersion', 'utf16le')
  const at = assembly.lastIndexOf(key)
  if (at < 0) return null
  let i = at + key.length
  while (i + 1 < assembly.length && assembly[i] === 0 && assembly[i + 1] === 0) i += 2
  let value = ''
  for (; i + 1 < assembly.length && value.length < 64; i += 2) {
    const code = assembly.readUInt16LE(i)
    if (code === 0) break
    value += String.fromCharCode(code)
  }
  return value.match(/^\d+(?:\.\d+){2,4}/)?.[0] ?? null
}

const scanCache = new Map<string, { key: string; version: string | null }>()

const GAME_ASSEMBLY: Record<Game, string> = { terraria: TERRARIA_ASSEMBLY, tshock: TSHOCK_GAME_ASSEMBLY, tmodloader: TML_ASSEMBLY }

/** Versione di Terraria di un'installazione letta dal suo assembly (in cache finché il file non cambia). */
export function assemblyGameVersion(installDir: string, game: Game): Promise<string | null> {
  return assemblyVersion(join(installDir, GAME_ASSEMBLY[game]))
}

/** FileVersion di un assembly .NET (in cache finché il file non cambia); null se manca. */
export async function assemblyVersion(file: string): Promise<string | null> {
  let key: string
  try {
    const info = await stat(file)
    key = `${info.size}:${info.mtimeMs}`
  } catch {
    return null
  }
  const cached = scanCache.get(file)
  if (cached?.key === key) return cached.version
  const version = scanGameVersion(await readFile(file))
  scanCache.set(file, { key, version })
  return version
}

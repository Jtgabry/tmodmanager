import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { basename } from 'node:path'

export type ServerSettings = {
  world: string | null
  worldName: string | null
  port: number
  maxPlayers: number
  hasPassword: boolean
  motd: string | null
}

/** Default di Terraria quando una chiave non è impostata in serverconfig.txt. */
const DEFAULT_PORT = 7777
const DEFAULT_MAX_PLAYERS = 8

/** Legge le coppie chiave=valore di serverconfig.txt, ignorando commenti (#) e righe vuote. */
export function parseServerConfig(text: string): ServerSettings {
  const values = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq > 0) values.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim())
  }

  const world = values.get('world') || null
  const port = Number(values.get('port'))
  const maxPlayers = Number(values.get('maxplayers'))

  return {
    world,
    worldName: world ? basename(world).replace(/\.wld$/i, '') : (values.get('worldname') ?? null),
    port: Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT,
    maxPlayers: Number.isInteger(maxPlayers) && maxPlayers > 0 ? maxPlayers : DEFAULT_MAX_PLAYERS,
    hasPassword: Boolean(values.get('password')),
    motd: values.get('motd') ?? null,
  }
}

export async function readServerConfig(path: string): Promise<ServerSettings> {
  try {
    return parseServerConfig(await readFile(path, 'utf8'))
  } catch {
    return parseServerConfig('')
  }
}

/** Password impostata in serverconfig.txt ('' se nessuna). Non va mai restituita da un'API. */
export async function readConfigPassword(path: string): Promise<string> {
  const text = await readFile(path, 'utf8').catch(() => '')
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.toLowerCase().startsWith('password=')) return line.slice('password='.length).trim()
  }
  return ''
}

/** Versione di tModLoader dalla prima riga del log ("Starting tModLoader server 1.4.4.9+2026.09.3.1|…"). */
export function parseTmlVersion(logHead: string): string | null {
  return logHead.match(/Starting tModLoader server [\d.]+\+v?([\d.]+)/)?.[1] ?? null
}

/**
 * Imposta (o, con null, rimuove) chiavi di serverconfig.txt mantenendo commenti e ordine.
 * Una chiave già presente viene sostituita al suo posto; le nuove vanno in fondo.
 */
export function applyServerConfig(text: string, changes: Record<string, string | null>): string {
  const pending = new Map(Object.entries(changes).map(([k, v]) => [k.toLowerCase(), v]))
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of lines) {
    const line = raw.trim()
    const eq = line.indexOf('=')
    const key = !line.startsWith('#') && eq > 0 ? line.slice(0, eq).trim().toLowerCase() : null
    if (key !== null && pending.has(key)) {
      if (seen.has(key)) continue // chiave duplicata: vale una sola riga
      seen.add(key)
      const value = pending.get(key)
      if (value !== null && value !== undefined) out.push(`${key}=${value}`)
      continue
    }
    out.push(raw)
  }
  while (out.length && out[out.length - 1] === '') out.pop()
  for (const [key, value] of pending) if (!seen.has(key) && value !== null) out.push(`${key}=${value}`)
  return `${out.join('\n')}\n`
}

/** Valori ammessi per le chiavi di serverconfig.txt modificabili dal pannello (null = chiave tolta, cioè il default di Terraria). */
const choice = (...values: string[]) => z.enum(values as [string, ...string[]])
const journey = choice('0', '1', '2')

/** Permessi della modalità Viaggio (0 bloccato per tutti, 1 solo l'host, 2 tutti). */
export const JOURNEY_PERMISSIONS = [
  'time_setfrozen',
  'time_setdawn',
  'time_setnoon',
  'time_setdusk',
  'time_setmidnight',
  'time_setspeed',
  'godmode',
  'wind_setstrength',
  'wind_setfrozen',
  'rain_setstrength',
  'rain_setfrozen',
  'increaseplacementrange',
  'setdifficulty',
  'biomespread_setfrozen',
  'setspawnrate',
] as const

/**
 * Chiavi di serverconfig.txt che il pannello sa modificare (oltre a porta, giocatori, password e motd,
 * che hanno i loro campi). world, worldpath, banlist e upnp li gestisce tModManager.
 */
export const ConfigValues = z
  .object({
    secure: choice('0', '1'),
    language: choice('en-US', 'de-DE', 'it-IT', 'fr-FR', 'es-ES', 'ru-RU', 'zh-Hans', 'pt-BR', 'pl-PL'),
    npcstream: z.string().regex(/^\d{1,4}$/, 'a number from 0 to 9999'),
    autocreate: choice('1', '2', '3'),
    worldname: z.string().regex(/^[A-Za-z0-9 _'-]{1,40}$/, 'lettere, numeri, spazi, _ - \' (max 40)'),
    difficulty: choice('0', '1', '2', '3'),
    seed: z.string().max(64).regex(/^[^\r\n\0]*$/, 'cannot contain line breaks'),
    ...Object.fromEntries(JOURNEY_PERMISSIONS.map((p) => [`journeypermission_${p}`, journey])),
  })
  .partial()
export type ConfigValues = z.infer<typeof ConfigValues>
export const CONFIG_KEYS = Object.keys(ConfigValues.shape)

/** Modifiche: valore nuovo o null per togliere la chiave. Chiavi sconosciute rifiutate. */
export const ConfigChanges = z
  .object(Object.fromEntries(Object.entries(ConfigValues.shape).map(([k, schema]) => [k, schema.unwrap().nullable().optional()])))
  .strict()

/** Valori attuali delle chiavi modificabili (solo quelle presenti nel file). */
export function readConfigValues(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim().toLowerCase()
    if (CONFIG_KEYS.includes(key) && !(key in out)) out[key] = line.slice(eq + 1).trim()
  }
  return out
}

import { readFile } from 'node:fs/promises'
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

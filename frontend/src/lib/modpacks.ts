import type { Mod, Modpack } from './types'

export const PACK_STATE: Record<Modpack['state'], { text: string; className: string }> = {
  enabled: { text: 'Attivo', className: 'pill pill-on' },
  partial: { text: 'Attivo in parte', className: 'pill pill-update' },
  disabled: { text: 'Disattivo', className: 'pill pill-off' },
}

/** Mod del pack nell'ordine del pack (undefined per quelle non installate). */
export const packModsOf = (pack: Modpack, byName: Map<string, Mod>) => pack.mods.map((name) => byName.get(name))

/** Dimensione totale delle mod installate del pack. */
export const packSize = (pack: Modpack, byName: Map<string, Mod>) => pack.mods.reduce((sum, name) => sum + (byName.get(name)?.size ?? 0), 0)

/** Avvia il download di un file dato il suo indirizzo (o un blob). */
function download(href: string, filename?: string) {
  const a = document.createElement('a')
  a.href = href
  a.download = filename ?? ''
  a.click()
}

/** Scarica l'elenco delle mod come .json (lo stesso formato che «Importa da tModLoader» accetta). */
export function downloadPackJson(pack: Modpack) {
  const blob = new Blob([`${JSON.stringify(pack.mods, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  download(url, `${pack.name.replace(/[\\/:*?"<>|]+/g, '_')}.json`)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Scarica la cartella del pack per tModLoader in .zip (Mods/ con i .tmod ed enabled.json, ModConfigs/).
 * Lo zip lo prepara il server al momento: il nome del file arriva da lì.
 */
export function downloadPackZip(serverId: string, pack: Modpack) {
  download(`/api/v1/servers/${serverId}/modpacks/${pack.id}/export`)
}

/** Un nome libero tra quelli dei pack esistenti: «Nome», poi «Nome (2)», «Nome (3)»… */
export function freeName(base: string, packs: Modpack[]) {
  const taken = new Set(packs.map((p) => p.name.toLowerCase()))
  const root = base.slice(0, 56)
  let name = base.slice(0, 64)
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${root} (${i})`
  return name
}

/** Dipendenze (anche indirette) delle mod indicate, note dalle mod installate. */
export function dependencyClosure(names: string[], byName: Map<string, Mod>): Set<string> {
  const seen = new Set<string>()
  const stack = [...names]
  while (stack.length) {
    const name = stack.pop()!
    for (const dep of byName.get(name)?.dependencies ?? []) {
      if (!seen.has(dep)) {
        seen.add(dep)
        stack.push(dep)
      }
    }
  }
  return seen
}

/** Riepilogo dell'attivazione o disattivazione di un pack. */
export function activationNotice(
  packName: string,
  active: boolean,
  r: { enabled?: string[]; disabled?: string[]; kept?: string[]; deactivated?: string[]; switched?: { name: string; from: string | null; to: string }[] },
  nameOf: (name: string) => string,
) {
  const parts: string[] = []
  if (r.switched?.length) parts.push(`versioni cambiate: ${r.switched.map((s) => `${nameOf(s.name)} ${s.from ? `v${s.from} → ` : ''}v${s.to}`).join(', ')}`)
  if (r.enabled?.length) parts.push(`abilitate: ${r.enabled.map(nameOf).join(', ')}`)
  if (r.disabled?.length) parts.push(`disabilitate: ${r.disabled.map(nameOf).join(', ')}`)
  if (r.deactivated?.length) parts.push(`pack disattivati: ${r.deactivated.join(', ')}`)
  if (r.kept?.length) parts.push(`rimaste attive (servono ad altri pack o mod): ${r.kept.map(nameOf).join(', ')}`)
  return `${packName} ${active ? 'attivato' : 'disattivato'}${parts.length ? ` — ${parts.join('; ')}` : ' (nessuna modifica alle mod)'}. Riavvia il server per applicare.`
}

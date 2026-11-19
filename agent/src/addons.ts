import { join } from 'node:path'
import { config } from './config.js'

/**
 * Add-on di tModManager: scritti per il pannello, con il sorgente in addons/<Nome>/ e compilati nell'immagine
 * dell'agent (config.addonsDir). Si aggiornano insieme al pannello. Due tipi:
 *  - plugin TShock (ADDONS, <Nome>.dll): compaiono tra i plugin di ogni server TShock, disattivati;
 *  - mod tModLoader (MOD_ADDONS, <Nome>.tmod): compaiono nel Workshop del pannello come una mod da installare,
 *    e una volta installati sono mod come le altre (vedi modAddons.ts). Mai collegati allo Steam Workshop e mai
 *    esportati nei modpack: restano sul server.
 */
export type Addon = {
  /** Nome dell'assembly e del file (<name>.dll). */
  name: string
  /** Cosa fa, per l'elenco dei plugin. */
  description: string
}

export const ADDONS: Addon[] = [
  {
    name: 'LiveMap',
    description:
      'Mappa del mondo in tempo reale per il pannello. Lavora solo mentre qualcuno la guarda e al massimo 1 ms per tick.',
  },
]

export const addonPath = (addon: Addon) => join(config.addonsDir, `${addon.name}.dll`)

export type ModAddon = {
  /** Nome interno della mod (Mods/<name>.tmod, enabled.json). */
  name: string
  /** Tag del Workshop con cui compare (filtri per categoria). */
  tags: string[]
  /** Parole (oltre a titolo e descrizione) con cui la trova la ricerca nel Workshop. */
  keywords: string[]
}

export const MOD_ADDONS: ModAddon[] = [{ name: 'TmmLiveMap', tags: ['Utilities'], keywords: ['map', 'mappa', 'livemap', 'tmodmanager'] }]

export const modAddonPath = (addon: ModAddon) => join(config.addonsDir, `${addon.name}.tmod`)

/** ID con cui l'add-on compare nel Workshop del pannello (non numerico: non si confonde con quelli di Steam). */
export const addonItemId = (addon: ModAddon) => `tmm-${addon.name}`
export const ADDON_ITEM_ID = /^tmm-[A-Za-z0-9_]{1,64}$/

export const findModAddon = (name: string) => MOD_ADDONS.find((a) => a.name === name)
export const isModAddon = (name: string) => findModAddon(name) !== undefined
export const modAddonByItemId = (id: string) => MOD_ADDONS.find((a) => addonItemId(a) === id)

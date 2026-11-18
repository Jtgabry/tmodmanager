import { join } from 'node:path'
import { config } from './config.js'

/**
 * Add-on di tModManager: plugin TShock scritti per il pannello, con il sorgente in addons/<Nome>/ e
 * compilati nell'immagine dell'agent (config.addonsDir). Compaiono tra i plugin di ogni server TShock,
 * disattivati finché non li si attiva, e si aggiornano insieme al pannello.
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

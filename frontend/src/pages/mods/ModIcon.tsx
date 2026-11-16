import { useState } from 'react'
import { modImageUrl } from '../../lib/mods'
import type { Mod } from '../../lib/types'

type IconMod = Pick<Mod, 'name' | 'displayName' | 'modifiedAt' | 'hasIcon' | 'error' | 'workshop'>

/** Iniziali al posto dell'immagine (mod senza icona, o non installata). */
export function ModInitials({ title, size = 80 }: { title: string; size?: number }) {
  return (
    <span className="mod-icon mod-icon-fallback" style={size !== 80 ? { width: size, height: size } : undefined} aria-hidden="true">
      {title.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?'}
    </span>
  )
}

/** Icona della mod (dal .tmod; se non c'è, l'anteprima del Workshop; altrimenti le iniziali). */
export default function ModIcon({ serverId, mod, size = 80 }: { serverId: string; mod: IconMod; size?: number }) {
  const [failed, setFailed] = useState(false)
  // Il controllo hasIcon manca con un agent non aggiornato: in quel caso si prova comunque l'icona
  const src = mod.hasIcon === undefined ? modImageUrl(serverId, { ...mod, hasIcon: true }) : modImageUrl(serverId, mod)
  const title = mod.displayName ?? mod.name
  if (failed || mod.error || !src) return <ModInitials title={title} size={size} />
  const isIcon = src.startsWith('/api/')
  return (
    <img
      className={isIcon ? 'mod-icon' : 'mod-icon workshop-thumb'}
      src={src}
      alt=""
      loading="lazy"
      width={size}
      height={size}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}

import { modImageUrl } from '../../lib/mods'
import type { Mod } from '../../lib/types'

/**
 * Copertina di un modpack, ricavata dalle mod: con almeno 3 mod con immagine, mosaico 2×2 delle
 * prime 4 (con 3 il quarto riquadro resta vuoto); con 1 o 2, l'immagine della prima; senza, un segnaposto.
 */
export default function PackCover({ serverId, packMods, size = 80 }: { serverId: string; packMods: (Mod | undefined)[]; size?: number }) {
  const images = packMods.flatMap((m) => {
    const src = m && !m.error ? modImageUrl(serverId, m) : null
    return src ? [{ src, icon: src.startsWith('/api/') }] : []
  })
  const style = { width: size, height: size }

  if (images.length >= 3) {
    const cells = [...images.slice(0, 4), ...Array(Math.max(0, 4 - images.length)).fill(null)] as ({ src: string; icon: boolean } | null)[]
    return (
      <span className="pack-cover pack-cover-mosaic" style={style} aria-hidden="true">
        {cells.map((c, i) =>
          c ? <img key={i} src={c.src} alt="" loading="lazy" referrerPolicy={c.icon ? undefined : 'no-referrer'} className={c.icon ? 'pixel' : undefined} /> : <span key={i} />,
        )}
      </span>
    )
  }
  if (images.length > 0) {
    return (
      <img
        className={images[0].icon ? 'mod-icon' : 'mod-icon workshop-thumb'}
        style={style}
        src={images[0].src}
        alt=""
        loading="lazy"
        referrerPolicy={images[0].icon ? undefined : 'no-referrer'}
      />
    )
  }
  return (
    <span className="pack-cover pack-cover-empty" style={style} aria-hidden="true">
      <svg className="ic" viewBox="0 0 24 24">
        <rect x="3" y="3" width="8" height="8" rx="1" />
        <rect x="13" y="3" width="8" height="8" rx="1" />
        <rect x="3" y="13" width="8" height="8" rx="1" />
        <path d="M17 14v6M14 17h6" />
      </svg>
    </span>
  )
}

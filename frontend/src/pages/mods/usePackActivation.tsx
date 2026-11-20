import { useState } from 'react'
import Sheet from '../../components/Sheet'
import { errorMessage } from '../../lib/api'
import { activationNotice, dependencyClosure } from '../../lib/modpacks'
import { useModpackActivation } from '../../lib/mods'
import type { Mod, Modpack } from '../../lib/types'
import { t, tn } from '../../i18n'

export type ActivationProps = {
  serverId: string
  pack: Modpack
  packs: Modpack[]
  byName: Map<string, Mod>
  /** Il pack non si può attivare (mod mancanti, versioni non disponibili, vuoto). */
  blocked: boolean
  onResult: (notice: string | null, error: string | null) => void
}

/**
 * Attivazione di un pack:
 * - `toggle`: «Attiva» (abilita le mod del pack, il resto resta com'è) o «Disattiva»;
 * - `exclusive`: «Solo questo» (abilita le mod del pack e disabilita tutte le altre), con conferma
 *   se spegne qualcosa. `dialog` va messo nella pagina (è la finestra di conferma).
 */
export function usePackActivation({ serverId, pack, packs, byName, onResult }: ActivationProps) {
  const activation = useModpackActivation(serverId)
  const [confirming, setConfirming] = useState(false)
  const nameOf = (name: string) => byName.get(name)?.displayName ?? name

  // Cosa spegnerebbe «Solo questo»: le mod abilitate che non sono del pack né sue dipendenze
  const keep = new Set([...pack.mods, ...dependencyClosure(pack.mods, byName)])
  const toDisable = [...byName.values()].filter((m) => m.enabled && !keep.has(m.name)).map((m) => m.name)
  const otherActive = packs.filter((p) => p.id !== pack.id && p.active).map((p) => p.name)

  const run = (active: boolean, exclusive = false) => {
    setConfirming(false)
    onResult(null, null)
    activation.mutate(
      { id: pack.id, active, exclusive },
      {
        onSuccess: (r) => onResult(activationNotice(exclusive ? `${pack.name} ${t('(only this one)')}` : pack.name, active, r, nameOf), null),
        onError: (err) => onResult(null, errorMessage(err)),
      },
    )
  }

  const dialog = (
    // I clic nella finestra non devono arrivare alla card (che si aprirebbe)
    <span onClick={(e) => e.stopPropagation()}>
      <Sheet open={confirming} title={t('Activate only «{name}»?', { name: pack.name })} onClose={() => setConfirming(false)}>
        <div className="stack">
          <p>{t('Only the mods of this pack and their dependencies stay enabled.')}</p>
          {toDisable.length > 0 && (
            <p>
              {tn('{count} mods will be disabled: {mods}.', { count: <strong>{toDisable.length}</strong>, mods: toDisable.map(nameOf).join(', ') })}
            </p>
          )}
          {otherActive.length > 0 && <p>{t('These will be deactivated too: {packs}.', { packs: otherActive.join(', ') })}</p>}
          <p className="muted small">{t('Mods are not deleted: you can enable them again whenever you want. Then restart the server.')}</p>
          <div className="btn-row">
            <button type="button" className="btn btn-warning" onClick={() => run(true, true)}>
              {t('Activate only this one')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
              {t('Cancel')}
            </button>
          </div>
        </div>
      </Sheet>
    </span>
  )

  return {
    busy: activation.isPending,
    toggle: () => run(!pack.active),
    /** «Solo questo» serve se il pack non è attivo, o se è attivo ma ci sono altre mod o altri pack accesi. */
    exclusiveUseful: !pack.active || toDisable.length > 0 || otherActive.length > 0,
    exclusive: () => (toDisable.length || otherActive.length ? setConfirming(true) : run(true, true)),
    dialog,
  }
}

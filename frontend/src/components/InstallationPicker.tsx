import { type Picked } from '../lib/installationPicker'
import { GAME_LABEL } from '../lib/types'

/** Spiegazione della scelta: principale condivisa, versione fissa, da installare. */
export function PickedHint({ picked }: { picked: Picked | null }) {
  if (!picked) return null
  const label = GAME_LABEL[picked.game]
  if (picked.release) {
    return (
      <span>
        {label} {picked.release.version} viene installato come versione fissa, solo per i server che la scelgono: non cambia
        quando si aggiornano le altre installazioni.
      </span>
    )
  }
  const c = picked.choice
  if (!c) return null
  if (!c.managed) return <span>Installazione esterna al pannello.</span>
  if (c.pinned) {
    return c.installed ? (
      <span>Versione fissa: non si aggiorna da sola, il server si aggiorna passando a un'altra versione.</span>
    ) : (
      <span>Versione fissa in installazione.</span>
    )
  }
  return (
    <span>
      Installazione principale di {label}, condivisa: aggiornandola si aggiornano tutti i server che la usano.
      {!c.installed && (c.installing ? ' Si sta già installando.' : " Non è ancora installata: viene installata l'ultima versione.")}
    </span>
  )
}

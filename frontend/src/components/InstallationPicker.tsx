import { type Picked } from '../lib/installationPicker'
import { GAME_LABEL } from '../lib/types'
import { t } from '../i18n'

/** Spiegazione della scelta: principale condivisa, versione fissa, da installare. */
export function PickedHint({ picked }: { picked: Picked | null }) {
  if (!picked) return null
  const label = GAME_LABEL[picked.game]
  if (picked.release) {
    return (
      <span>
        {t(
          '{game} {version} is installed as a pinned version, only for the servers that choose it: it does not change when the other installations are updated.',
          { game: label, version: picked.release.version },
        )}
      </span>
    )
  }
  const c = picked.choice
  if (!c) return null
  if (!c.managed) return <span>{t('Installation outside the panel.')}</span>
  if (c.pinned) {
    return c.installed ? (
      <span>{t('Pinned version: it does not update by itself, the server is updated by switching to another version.')}</span>
    ) : (
      <span>{t('Pinned version being installed.')}</span>
    )
  }
  return (
    <span>
      {t('Main {game} installation, shared: updating it updates all the servers that use it.', { game: label })}
      {!c.installed && ` ${c.installing ? t('It is already being installed.') : t('It is not installed yet: the latest version is installed.')}`}
    </span>
  )
}

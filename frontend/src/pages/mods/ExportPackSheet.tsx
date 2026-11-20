import { type FormEvent, useState } from 'react'
import Sheet from '../../components/Sheet'
import { downloadPackJson, downloadPackZip } from '../../lib/modpacks'
import type { Modpack } from '../../lib/types'
import { t, tn } from '../../i18n'

type Format = 'zip' | 'json'

/** Esportazione di un modpack: cartella di tModLoader in .zip (predefinita) o solo l'elenco in .json. */
export default function ExportPackSheet({ serverId, pack, onClose }: { serverId: string; pack: Modpack | null; onClose: () => void }) {
  return (
    <Sheet open={pack !== null} title={t('Export the modpack')} onClose={onClose}>
      {pack && <ExportForm serverId={serverId} pack={pack} onClose={onClose} />}
    </Sheet>
  )
}

function ExportForm({ serverId, pack, onClose }: { serverId: string; pack: Modpack; onClose: () => void }) {
  const [format, setFormat] = useState<Format>('zip')
  const notInZip = [...pack.missing, ...pack.unavailable]
  const addons = pack.addons ?? []
  const exportable = pack.mods.filter((m) => !addons.includes(m))

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (format === 'zip') downloadPackZip(serverId, pack)
    else downloadPackJson(pack)
    onClose()
  }

  return (
    <form className="stack" onSubmit={submit}>
      <div className="choice-list" role="radiogroup" aria-label={t('Format')}>
        <label className="choice">
          <input type="radio" name="format" value="zip" checked={format === 'zip'} onChange={() => setFormat('zip')} />
          <span>
            <strong>{t('Modpack folder (.zip)')}</strong>
            <span className="muted small">
              {tn(
                'A «{name}» folder with {mods} (the mod files, at the pack versions, with dependencies) and {configs} (their configurations). It can be used as is in tModLoader.',
                { name: pack.name, mods: <code>Mods</code>, configs: <code>ModConfigs</code> },
              )}
            </span>
          </span>
        </label>
        <label className="choice">
          <input type="radio" name="format" value="json" checked={format === 'json'} onChange={() => setFormat('json')} />
          <span>
            <strong>{t('Only the list of mods (.json)')}</strong>
            <span className="muted small">{t('The mod names, without files or configurations: lightweight, to import where the mods are already there.')}</span>
          </span>
        </label>
      </div>

      {addons.length > 0 && (
        <div className="alert alert-info">
          {addons.length === 1
            ? t('LiveMap stays on the server: it is not exported')
            : t('The tModManager add-ons stay on the server: they are not exported')}
          {exportable.length === 0 ? t(', and there is nothing else in the pack.') : '.'}
        </div>
      )}

      {format === 'zip' && notInZip.length > 0 && (
        <div className="alert alert-warning">
          {t('They are not on the server, so they will not be in the zip: {mods}.', { mods: notInZip.join(', ') })}
        </div>
      )}

      <div className="btn-row btn-row-end">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {t('Cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={exportable.length === 0}>
          {t('Download')}
        </button>
      </div>
    </form>
  )
}

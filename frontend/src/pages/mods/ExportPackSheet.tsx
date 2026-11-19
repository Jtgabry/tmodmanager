import { type FormEvent, useState } from 'react'
import Sheet from '../../components/Sheet'
import { downloadPackJson, downloadPackZip } from '../../lib/modpacks'
import type { Modpack } from '../../lib/types'

type Format = 'zip' | 'json'

/** Esportazione di un modpack: cartella di tModLoader in .zip (predefinita) o solo l'elenco in .json. */
export default function ExportPackSheet({ serverId, pack, onClose }: { serverId: string; pack: Modpack | null; onClose: () => void }) {
  return (
    <Sheet open={pack !== null} title="Esporta il modpack" onClose={onClose}>
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
      <div className="choice-list" role="radiogroup" aria-label="Formato">
        <label className="choice">
          <input type="radio" name="format" value="zip" checked={format === 'zip'} onChange={() => setFormat('zip')} />
          <span>
            <strong>Cartella del modpack (.zip)</strong>
            <span className="muted small">
              Una cartella «{pack.name}» con <code>Mods</code> (i file delle mod, alle versioni del pack, con le dipendenze) e{' '}
              <code>ModConfigs</code> (le loro configurazioni). Si usa così com'è in tModLoader.
            </span>
          </span>
        </label>
        <label className="choice">
          <input type="radio" name="format" value="json" checked={format === 'json'} onChange={() => setFormat('json')} />
          <span>
            <strong>Solo l'elenco delle mod (.json)</strong>
            <span className="muted small">I nomi delle mod, senza file né configurazioni: leggero, da importare dove le mod ci sono già.</span>
          </span>
        </label>
      </div>

      {addons.length > 0 && (
        <div className="alert alert-info">
          {addons.length === 1 ? 'LiveMap resta' : 'Gli add-on di tModManager restano'} sul server: non {addons.length === 1 ? 'viene esportata' : 'vengono esportati'}
          {exportable.length === 0 ? ', e nel pack non c\'è nient\'altro.' : '.'}
        </div>
      )}

      {format === 'zip' && notInZip.length > 0 && (
        <div className="alert alert-warning">
          Non sono sul server, quindi non saranno nello zip: {notInZip.join(', ')}.
        </div>
      )}

      <div className="btn-row btn-row-end">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Annulla
        </button>
        <button type="submit" className="btn btn-primary" disabled={exportable.length === 0}>
          Scarica
        </button>
      </div>
    </form>
  )
}

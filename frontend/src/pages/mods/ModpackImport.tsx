import { type ChangeEvent, useRef, useState } from 'react'
import { errorMessage } from '../../lib/api'
import { useImportablePacks, useImportModpack } from '../../lib/mods'
import type { ModpackImportResult } from '../../lib/types'

/**
 * Importazione dei modpack creati nel gioco (menu Mod Pack di tModLoader).
 * Il pack diventa un modpack del pannello; le mod contenute nel pack vengono installate.
 */
export default function ModpackImport({ serverId, onClose, inDialog = false }: { serverId: string; onClose: () => void; inDialog?: boolean }) {
  const importable = useImportablePacks(serverId, true)
  const importPack = useImportModpack(serverId)
  const [replaceExisting, setReplaceExisting] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [result, setResult] = useState<ModpackImportResult | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const run = (vars: { name?: string; file?: File }) => {
    setResult(null)
    setProgress(vars.file ? 0 : null)
    importPack.mutate(
      { ...vars, replaceExisting, onProgress: setProgress },
      { onSuccess: setResult, onSettled: () => setProgress(null) },
    )
  }

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) run({ file })
  }

  return (
    <div className={inDialog ? 'stack' : 'pack-form'}>
      {!inDialog && (
        <div className="section-header">
          <h3>Importa da tModLoader</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Chiudi
          </button>
        </div>
      )}
      <p className="muted small">
        Sul PC i modpack del gioco stanno in{' '}
        <span className="mono">Documenti/My Games/Terraria/tModLoader/Mods/ModPacks</span> (dal gioco: menu Mod Pack →
        «Open Mod Pack Folder»). Comprimi in .zip la cartella di un pack e caricala qui: le mod contenute vengono
        installate. Un pack salvato come .json contiene solo l'elenco delle mod. In alternativa copia la cartella del pack
        in <span className="mono">SaveData/Mods/ModPacks</span> dal file manager e importala dall'elenco qui sotto.
      </p>

      <label className="checkbox">
        <input type="checkbox" checked={replaceExisting} onChange={(e) => setReplaceExisting(e.target.checked)} />
        <span>Se una mod è già installata con un'altra versione, usa quella del pack (la versione attuale va in backup)</span>
      </label>

      <div className="btn-row">
        <button type="button" className="btn btn-primary btn-sm" disabled={importPack.isPending} onClick={() => fileInput.current?.click()}>
          Carica .zip o .json…
        </button>
        <input ref={fileInput} type="file" accept=".zip,.json" hidden onChange={onFile} />
      </div>
      {progress !== null && (
        <div className="progress">
          <div style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {importPack.isPending && progress === null && <p className="muted small">Importazione in corso…</p>}

      <h4>Pack nella cartella del server</h4>
      {importable.isLoading && <div className="spinner" />}
      {importable.data?.length === 0 && <p className="muted small">Nessun pack in SaveData/Mods/ModPacks.</p>}
      {importable.data && importable.data.length > 0 && (
        <ul className="upload-list">
          {importable.data.map((p) => (
            <li key={p.name} className="upload-row">
              <span>
                <strong>{p.name}</strong>{' '}
                <span className="muted small">
                  {p.mods} mod{p.format === 'folder' ? `, ${p.files} file .tmod inclusi` : ' (solo elenco)'}
                </span>
              </span>
              <button type="button" className="btn btn-sm" disabled={importPack.isPending} onClick={() => run({ name: p.name })}>
                Importa
              </button>
            </li>
          ))}
        </ul>
      )}

      {importPack.isError && <div className="alert alert-error">{errorMessage(importPack.error)}</div>}
      {result && (
        <div className="alert alert-success">
          <p>
            Creato il modpack <strong>{result.pack.name}</strong> con {result.pack.mods.length} mod (non ancora attivo).
          </p>
          {result.installed.length > 0 && <p>Installate: {result.installed.join(', ')}</p>}
          {result.updated.length > 0 && <p>Aggiornate: {result.updated.join(', ')}</p>}
          {result.skipped.length > 0 && (
            <p>
              Non toccate: {result.skipped.map((s) => `${s.name} (${s.reason})`).join('; ')}
            </p>
          )}
          {result.missing.length > 0 && (
            <p className="error-text">
              Mancano ancora: {result.missing.join(', ')} — caricale dalla sezione Mod per poter attivare il pack.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

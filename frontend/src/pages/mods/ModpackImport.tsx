import { type ChangeEvent, useRef, useState } from 'react'
import { errorMessage } from '../../lib/api'
import { useImportablePacks, useImportModpack } from '../../lib/mods'
import type { ModpackImportResult } from '../../lib/types'
import { t, tn } from '../../i18n'

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
          <h3>{t('Import from tModLoader')}</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            {t('Close')}
          </button>
        </div>
      )}
      <p className="muted small">
        {tn(
          'On the PC the game modpacks are in {folder} (from the game: Mod Pack menu → «Open Mod Pack Folder»). Zip a pack folder and upload it here: the mods it contains are installed. A pack saved as .json only contains the list of mods. Alternatively copy the pack folder to {serverFolder} with the file manager and import it from the list below.',
          {
            folder: <span className="mono">Documents/My Games/Terraria/tModLoader/Mods/ModPacks</span>,
            serverFolder: <span className="mono">SaveData/Mods/ModPacks</span>,
          },
        )}
      </p>

      <label className="checkbox">
        <input type="checkbox" checked={replaceExisting} onChange={(e) => setReplaceExisting(e.target.checked)} />
        <span>{t('If a mod is already installed with another version, use the pack one (the current version is backed up)')}</span>
      </label>

      <div className="btn-row">
        <button type="button" className="btn btn-primary btn-sm" disabled={importPack.isPending} onClick={() => fileInput.current?.click()}>
          {t('Upload .zip or .json…')}
        </button>
        <input ref={fileInput} type="file" accept=".zip,.json" hidden onChange={onFile} />
      </div>
      {progress !== null && (
        <div className="progress">
          <div style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {importPack.isPending && progress === null && <p className="muted small">{t('Importing…')}</p>}

      <h4>{t('Packs in the server folder')}</h4>
      {importable.isLoading && <div className="spinner" />}
      {importable.data?.length === 0 && <p className="muted small">{t('No packs in SaveData/Mods/ModPacks.')}</p>}
      {importable.data && importable.data.length > 0 && (
        <ul className="upload-list">
          {importable.data.map((p) => (
            <li key={p.name} className="upload-row">
              <span>
                <strong>{p.name}</strong>{' '}
                <span className="muted small">
                  {t('{count} mods', { count: p.mods })}{p.format === 'folder' ? `, ${t('{count} .tmod files included', { count: p.files ?? 0 })}` : ` ${t('(list only)')}`}
                </span>
              </span>
              <button type="button" className="btn btn-sm" disabled={importPack.isPending} onClick={() => run({ name: p.name })}>
                {t('Import')}
              </button>
            </li>
          ))}
        </ul>
      )}

      {importPack.isError && <div className="alert alert-error">{errorMessage(importPack.error)}</div>}
      {result && (
        <div className="alert alert-success">
          <p>
            {tn('Created the modpack {name} with {count} mods (not active yet).', { name: <strong>{result.pack.name}</strong>, count: result.pack.mods.length })}
          </p>
          {result.installed.length > 0 && <p>{t('Installed: {mods}', { mods: result.installed.join(', ') })}</p>}
          {result.updated.length > 0 && <p>{t('Updated: {mods}', { mods: result.updated.join(', ') })}</p>}
          {result.skipped.length > 0 && (
            <p>
              {t('Not touched: {mods}', { mods: result.skipped.map((s) => `${s.name} (${s.reason})`).join('; ') })}
            </p>
          )}
          {result.missing.length > 0 && (
            <p className="error-text">
              {t('Still missing: {mods} — upload them from the Mods section to be able to activate the pack.', { mods: result.missing.join(', ') })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

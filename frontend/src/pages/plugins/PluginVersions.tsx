import { useState } from 'react'
import { errorMessage } from '../../lib/api'
import { formatBytes, formatDate } from '../../lib/format'
import { pluginDownloadUrl, pluginTitle, useDeletePluginVersion, usePruneVersions, useUsePluginVersion, versionLabel } from '../../lib/plugins'
import type { Plugin } from '../../lib/types'

const trashIcon = (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 7h16" />
    <path d="M10 11v6M14 11v6" />
    <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
    <path d="M9 7V4h6v3" />
  </svg>
)

const downloadIcon = (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 4v12" />
    <path d="M7 11l5 5 5-5" />
    <path d="M4 20h16" />
  </svg>
)

/** Versioni salvate di un plugin: scegliere quella da usare, scaricarle, eliminarle una a una o tutte le vecchie. */
export default function PluginVersions({ serverId, plugin }: { serverId: string; plugin: Plugin }) {
  const use = useUsePluginVersion(serverId)
  const remove = useDeletePluginVersion(serverId)
  const prune = usePruneVersions(serverId)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const title = pluginTitle(plugin)
  const busy = use.isPending || remove.isPending || prune.isPending
  const old = plugin.versions.filter((v) => v.id !== plugin.selected)
  // Due versioni con lo stesso numero (ricompilate senza cambiarlo): si distinguono per l'impronta
  const repeated = new Set(plugin.versions.map((v) => v.version).filter((v, i, all) => v && all.indexOf(v) !== i))

  const reset = () => {
    setNotice(null)
    setError(null)
  }

  const onUse = (id: string) => {
    reset()
    use.mutate(
      { name: plugin.name, id },
      {
        onSuccess: (p) => {
          const v = p.versions.find((x) => x.id === id)
          setNotice(
            p.enabled
              ? `${title}: in uso la ${v ? versionLabel(v) : 'versione scelta'}. Riavvia il server per caricarla.`
              : `${title}: scelta la ${v ? versionLabel(v) : 'versione'}, verrà usata quando attivi il plugin.`,
          )
        },
        onError: (err) => setError(errorMessage(err)),
      },
    )
  }

  const onDelete = (id: string) => {
    reset()
    const v = plugin.versions.find((x) => x.id === id)
    remove.mutate(
      { name: plugin.name, id },
      {
        onSuccess: () => setNotice(`${title} ${v ? versionLabel(v) : ''} spostata nel cestino.`),
        onError: (err) => setError(errorMessage(err)),
        onSettled: () => setConfirm(null),
      },
    )
  }

  const onPrune = () => {
    reset()
    prune.mutate(plugin.name, {
      onSuccess: (r) => setNotice(`${r.removed === 1 ? '1 versione spostata' : `${r.removed} versioni spostate`} nel cestino.`),
      onError: (err) => setError(errorMessage(err)),
      onSettled: () => setConfirm(null),
    })
  }

  return (
    <div className="stack">
      <p className="hint">
        Ogni .dll caricata resta salvata qui. Solo la versione scelta è in <span className="mono">ServerPlugins/</span>: cambiarla
        sostituisce il file, e TShock la carica al prossimo riavvio. Le versioni eliminate vanno nel cestino.
      </p>

      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      <ul className="archive-versions">
        {plugin.versions.map((v) => {
          const selected = v.id === plugin.selected
          return (
            <li key={v.id} className={selected ? 'archive-version archive-version-installed' : 'archive-version'}>
              <span className="archive-version-name">{versionLabel(v)}</span>
              {selected && <span className={plugin.enabled ? 'pill pill-on' : 'pill pill-plain'}>{plugin.enabled ? 'in uso' : 'scelta'}</span>}
              <span className="archive-version-meta">
                {formatBytes(v.size)} · caricata {formatDate(v.uploadedAt)}
                {(repeated.has(v.version) || !v.version) && <span className="mono"> · {v.id.slice(0, 8)}</span>}
              </span>
              <span className="archive-version-actions">
                {confirm === v.id ? (
                  <>
                    <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => onDelete(v.id)}>
                      Elimina
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(null)}>
                      Annulla
                    </button>
                  </>
                ) : (
                  <>
                    {!selected && (
                      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onUse(v.id)}>
                        {plugin.enabled ? 'Usa questa' : 'Scegli questa'}
                      </button>
                    )}
                    <a
                      className="btn btn-sm btn-icon"
                      href={pluginDownloadUrl(serverId, plugin.name, v.id)}
                      download
                      aria-label={`Scarica ${title} ${versionLabel(v)}`}
                      title="Scarica"
                    >
                      {downloadIcon}
                    </a>
                    {/* La versione attiva non si elimina (prima se ne sceglie un'altra); l'unica versione si toglie eliminando il plugin */}
                    {!(selected && plugin.enabled) && plugin.versions.length > 1 && (
                      <button
                        type="button"
                        className="btn btn-sm btn-icon btn-danger-outline"
                        disabled={busy}
                        aria-label={`Elimina ${title} ${versionLabel(v)}`}
                        title="Elimina questa versione"
                        onClick={() => setConfirm(v.id)}
                      >
                        {trashIcon}
                      </button>
                    )}
                  </>
                )}
              </span>
            </li>
          )
        })}
      </ul>

      {old.length > 0 && (
        <div className="btn-row">
          {confirm === 'old' ? (
            <>
              <span className="small">
                {old.length === 1 ? 'La versione non scelta' : `Le ${old.length} versioni non scelte`} andranno nel cestino.
              </span>
              <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={onPrune}>
                Conferma
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(null)}>
                Annulla
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-sm btn-danger-outline" disabled={busy} onClick={() => setConfirm('old')}>
              {trashIcon}
              Elimina le altre versioni ({old.length})
            </button>
          )}
        </div>
      )}
    </div>
  )
}

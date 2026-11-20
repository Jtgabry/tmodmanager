import { type ChangeEvent, useMemo, useRef, useState } from 'react'
import { errorMessage } from '../../lib/api'
import { formatBytes, formatDate } from '../../lib/format'
import { useArchive, useDeleteArchived, useMods, useUploadToArchive, useUseArchived } from '../../lib/mods'
import type { ArchivedVersion } from '../../lib/types'
import { t } from '../../i18n'

type Row = { name: string; title: string; installed: string | null; versions: ArchivedVersion[] }

/**
 * Archivio delle versioni: per ogni mod la versione installata e quelle archiviate, con «Installa»
 * (scambia le due) ed «Elimina». Si può caricare a mano un .tmod nell'archivio.
 * Con `focus` mostra solo quella mod (dettagli della mod, pagina del modpack).
 */
export default function VersionArchive({ serverId, focus }: { serverId: string; focus?: string }) {
  const archive = useArchive(serverId)
  const mods = useMods(serverId)
  const upload = useUploadToArchive(serverId)
  const remove = useDeleteArchived(serverId)
  const use = useUseArchived(serverId)
  const fileInput = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [confirm, setConfirm] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)

  const rows = useMemo((): Row[] => {
    const list = archive.data ?? []
    const installed = mods.data?.mods ?? []
    if (focus) {
      const entry = list.find((e) => e.name === focus)
      const mod = installed.find((m) => m.name === focus)
      return [{ name: focus, title: mod?.displayName ?? entry?.displayName ?? focus, installed: mod?.version ?? null, versions: entry?.versions ?? [] }]
    }
    const q = query.trim().toLowerCase()
    return list
      .map((e) => ({ name: e.name, title: e.displayName ?? e.name, installed: e.installedVersion, versions: e.versions }))
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.title.toLowerCase().includes(q))
  }, [archive.data, mods.data, focus, query])

  const onFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])]
    e.target.value = ''
    setError(null)
    setNotice(null)
    const added: string[] = []
    for (const [i, file] of files.entries()) {
      setProgress(`${file.name} (${i + 1}/${files.length})…`)
      try {
        const r = await upload.mutateAsync({ file })
        added.push(`${r.name} v${r.version}`)
      } catch (err) {
        setError(`${file.name}: ${errorMessage(err)}`)
      }
    }
    setProgress(null)
    if (added.length) setNotice(t('Added to the archive: {mods}.', { mods: added.join(', ') }))
  }

  const onUse = (row: Row, version: string) => {
    setError(null)
    setNotice(null)
    use.mutate(
      { name: row.name, version },
      {
        onSuccess: () =>
          setNotice(
            row.installed
              ? t('{mod}: installed v{version}, v{previous} is now in the archive. Restart the server to use it.', { mod: row.title, version, previous: row.installed })
              : t('{mod}: installed v{version}. Restart the server to use it.', { mod: row.title, version }),
          ),
        onError: (err) => setError(errorMessage(err)),
      },
    )
  }

  const onDelete = (row: Row, version: string) => {
    setError(null)
    setNotice(null)
    remove.mutate(
      { name: row.name, version },
      {
        onSuccess: () => setNotice(t('{mod} v{version} deleted from the archive.', { mod: row.title, version })),
        onError: (err) => setError(errorMessage(err)),
        onSettled: () => setConfirm(null),
      },
    )
  }

  const busy = use.isPending || remove.isPending

  return (
    <div className="stack">
      <div className="mods-toolbar">
        {!focus && (
          <label className="search-box">
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <input type="search" placeholder={t('Search a mod…')} aria-label={t('Search the archive')} value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        )}
        <button type="button" className="btn btn-sm" disabled={upload.isPending} onClick={() => fileInput.current?.click()}>
          <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 16V4" />
            <path d="M7 9l5-5 5 5" />
            <path d="M4 20h16" />
          </svg>
          {progress ? t('Uploading {file}', { file: progress }) : t('Add .tmod to the archive')}
        </button>
        <input ref={fileInput} type="file" accept=".tmod" multiple hidden onChange={(e) => void onFiles(e)} />
      </div>

      {!focus && (
        <p className="hint">
          {t(
            'The versions replaced by an update end up here, along with the ones you upload by hand. Modpacks can lock one of these versions: activating them installs it in place of the current one.',
          )}
        </p>
      )}

      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <div className="alert alert-error">{error}</div>}
      {(archive.error || mods.error) && <div className="alert alert-error">{errorMessage(archive.error ?? mods.error)}</div>}
      {archive.isLoading && <div className="spinner" />}

      {archive.data && rows.length === 0 && (
        <div className="empty">{query ? t('No mod matches the search.') : t('The archive is empty.')}</div>
      )}

      {rows.map((row) => (
        <div key={row.name} className="archive-mod">
          {!focus && <h3 className="archive-mod-title">{row.title}</h3>}
          <ul className="archive-versions">
            {row.installed && (
              <li className="archive-version archive-version-installed">
                <span className="archive-version-name">v{row.installed}</span>
                <span className="pill pill-on">{t('installed')}</span>
              </li>
            )}
            {row.versions.map((v) => {
              const key = `${row.name}@${v.version}`
              return (
                <li key={key} className="archive-version">
                  <span className="archive-version-name">v{v.version}</span>
                  <span className="archive-version-meta">
                    tModLoader {v.tmlVersion} · {formatBytes(v.size)} · {t('archived {date}', { date: formatDate(v.archivedAt) })}
                  </span>
                  <span className="archive-version-actions">
                    {confirm === key ? (
                      <>
                        <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => onDelete(row, v.version)}>
                          {t('Delete permanently')}
                        </button>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(null)}>
                          {t('Cancel')}
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onUse(row, v.version)}>
                          {t('Install this one')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-icon btn-danger-outline"
                          disabled={busy}
                          aria-label={t('Delete v{version} from the archive', { version: v.version })}
                          title={t('Delete from the archive')}
                          onClick={() => setConfirm(key)}
                        >
                          <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M4 7h16" />
                            <path d="M10 11v6M14 11v6" />
                            <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
                            <path d="M9 7V4h6v3" />
                          </svg>
                        </button>
                      </>
                    )}
                  </span>
                </li>
              )
            })}
            {focus && row.versions.length === 0 && (
              <li className="archive-version">
                <span className="muted small">{t('No previous version in the archive.')}</span>
              </li>
            )}
          </ul>
        </div>
      ))}
    </div>
  )
}

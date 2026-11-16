import { type DragEvent, type FormEvent, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { errorMessage, statusOf } from '../../lib/api'
import { useCurrentServer } from '../../lib/currentServer'
import { downloadUrl, type FileEntry, isTextFile, joinPath, useFileActions, useFileRoots, useListing } from '../../lib/files'
import { formatBytes, formatDate } from '../../lib/format'
import TextEditor from './TextEditor'

type UploadItem = { file: File; progress: number; status: 'queued' | 'uploading' | 'done' | 'error' | 'exists'; message?: string }

export default function FilesTab() {
  const server = useCurrentServer()
  const [params, setParams] = useSearchParams()
  const roots = useFileRoots(server.id)
  const root = params.get('root') ?? roots.data?.[0]?.id
  const path = params.get('path') ?? ''
  const editing = params.get('edit')
  const listing = useListing(server.id, root, path)
  const actions = useFileActions(server.id)

  const [renaming, setRenaming] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [creatingDir, setCreatingDir] = useState(false)
  const [dirName, setDirName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const go = (next: { root?: string; path?: string; edit?: string | null }) => {
    const p = new URLSearchParams()
    p.set('root', next.root ?? root ?? '')
    const nextPath = next.path ?? path
    if (nextPath) p.set('path', nextPath)
    if (next.edit) p.set('edit', next.edit)
    setParams(p)
    setError(null)
    setRenaming(null)
    setConfirmDelete(null)
  }

  if (roots.isLoading) return <div className="spinner" />
  if (roots.error) return <div className="alert alert-error">{errorMessage(roots.error)}</div>
  if (!root) return null

  if (editing) return <TextEditor serverId={server.id} root={root} path={editing} onClose={() => go({ edit: null })} />

  const segments = path ? path.split('/') : []
  const currentRoot = roots.data?.find((r) => r.id === root)
  // Cartella di tModLoader: niente cartelle nuove, si caricano/rinominano/eliminano solo i .txt di primo livello
  const limited = Boolean(currentRoot?.limited)
  const inLogs = limited && path !== ''
  const canModify = (entry: FileEntry) => !limited || (path === '' && entry.type === 'file' && /\.txt$/i.test(entry.name))
  const run = (promise: Promise<unknown>, after?: () => void) =>
    promise.then(() => after?.()).catch((err) => setError(errorMessage(err)))

  const updateUpload = (i: number, patch: Partial<UploadItem>) =>
    setUploads((list) => list.map((u, j) => (j === i ? { ...u, ...patch } : u)))

  const uploadOne = async (i: number, file: File, overwrite: boolean) => {
    updateUpload(i, { status: 'uploading', progress: 0, message: undefined })
    try {
      const r = await actions.upload.mutateAsync({ root, path, file, overwrite, onProgress: (p) => updateUpload(i, { progress: p }) })
      updateUpload(i, { status: 'done', progress: 1, message: r.replaced ? 'Sostituito (il vecchio è nel cestino)' : 'Caricato' })
    } catch (err) {
      if (statusOf(err) === 409 && !overwrite) updateUpload(i, { status: 'exists', message: errorMessage(err) })
      else updateUpload(i, { status: 'error', message: errorMessage(err) })
    }
  }

  const startUploads = async (files: File[]) => {
    const items = files.map((file): UploadItem => ({ file, progress: 0, status: 'queued' }))
    setUploads(items)
    for (const [i, item] of items.entries()) await uploadOne(i, item.file, false)
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files.length) startUploads([...e.dataTransfer.files])
  }

  const submitDir = (e: FormEvent) => {
    e.preventDefault()
    run(actions.mkdir.mutateAsync({ root, path, name: dirName }), () => {
      setCreatingDir(false)
      setDirName('')
    })
  }

  const submitRename = (e: FormEvent, entry: FileEntry) => {
    e.preventDefault()
    run(actions.rename.mutateAsync({ root, path: joinPath(path, entry.name), name: newName }), () => setRenaming(null))
  }

  const open = (entry: FileEntry) => {
    if (entry.type === 'dir') go({ path: joinPath(path, entry.name) })
    else if (entry.type === 'file' && isTextFile(entry.name)) go({ edit: joinPath(path, entry.name) })
  }

  return (
    <div
      className={`card files ${dragging ? 'dropzone-active' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <nav className="tabs root-tabs">
        {roots.data?.map((r) => (
          <button key={r.id} type="button" className={r.id === root ? 'active' : ''} onClick={() => go({ root: r.id, path: '' })} title={r.path}>
            {r.label}
          </button>
        ))}
      </nav>

      <div className="toolbar">
        <div className="breadcrumb">
          <button type="button" className="link-button" onClick={() => go({ path: '' })} title={currentRoot?.path}>
            {currentRoot?.label}
          </button>
          {segments.map((seg, i) => (
            <span key={`${seg}-${i}`}>
              {' / '}
              <button type="button" className="link-button" onClick={() => go({ path: segments.slice(0, i + 1).join('/') })}>
                {seg}
              </button>
            </span>
          ))}
        </div>
        <div className="btn-row">
          {!limited && (
            <button type="button" className="btn btn-sm" onClick={() => setCreatingDir((v) => !v)}>
              Nuova cartella
            </button>
          )}
          {!inLogs && (
            <button type="button" className="btn btn-sm" onClick={() => fileInput.current?.click()}>
              {limited ? 'Carica .txt' : 'Carica file'}
            </button>
          )}
          {(!limited || inLogs) && (
            <a className="btn btn-ghost btn-sm" href={downloadUrl(server.id, root, path)} download title="Scarica la cartella come .zip">
              Scarica cartella (.zip)
            </a>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept={limited ? '.txt' : undefined}
          onChange={(e) => {
            startUploads([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
      </div>

      {limited && (
        <p className="hint">
          Della cartella di tModLoader si vedono solo i file di configurazione (.txt, es. serverconfig.txt e banlist.txt)
          e i log: i file del programma non sono accessibili dal pannello.
        </p>
      )}

      {creatingDir && !limited && (
        <form className="form-inline" onSubmit={submitDir}>
          <label className="field">
            <span>Nome della cartella</span>
            <input autoFocus required value={dirName} onChange={(e) => setDirName(e.target.value)} />
          </label>
          <button type="submit" className="btn btn-primary btn-sm">
            Crea
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCreatingDir(false)}>
            Annulla
          </button>
        </form>
      )}

      {error && <div className="alert alert-error">{error}</div>}

      {uploads.length > 0 && (
        <ul className="upload-list">
          {uploads.map((u, i) => (
            <li key={`${u.file.name}-${i}`}>
              <div className="upload-row">
                <span>{u.file.name}</span>
                <span className="muted small">{formatBytes(u.file.size)}</span>
              </div>
              {u.status === 'uploading' && (
                <div className="progress">
                  <div style={{ width: `${Math.round(u.progress * 100)}%` }} />
                </div>
              )}
              {u.status === 'exists' && (
                <div className="btn-row">
                  <span className="small">{u.message}</span>
                  <button type="button" className="btn btn-warning btn-sm" onClick={() => uploadOne(i, u.file, true)}>
                    Sovrascrivi
                  </button>
                </div>
              )}
              {u.message && u.status !== 'exists' && <span className={u.status === 'error' ? 'error-text' : 'small'}>{u.message}</span>}
            </li>
          ))}
        </ul>
      )}

      {listing.isLoading && <div className="spinner" />}
      {listing.error && <div className="alert alert-error">{errorMessage(listing.error)}</div>}

      {listing.data && (
        <div className="table-wrap">
          <table className="table files-table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Dimensione</th>
                <th>Modificato</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {path && (
                <tr>
                  <td colSpan={4}>
                    <button type="button" className="link-button" onClick={() => go({ path: segments.slice(0, -1).join('/') })}>
                      ↑ ..
                    </button>
                  </td>
                </tr>
              )}
              {listing.data.entries.map((entry) => {
                const full = joinPath(path, entry.name)
                const openable = entry.type === 'dir' || (entry.type === 'file' && isTextFile(entry.name))
                return (
                  <tr key={entry.name}>
                    <td>
                      {renaming === entry.name ? (
                        <form className="inline-form" onSubmit={(e) => submitRename(e, entry)}>
                          <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} />
                          <button type="submit" className="btn btn-primary btn-sm">
                            OK
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRenaming(null)}>
                            Annulla
                          </button>
                        </form>
                      ) : (
                        <span className="file-name">
                          <span className="file-icon" aria-hidden>
                            {entry.type === 'dir' ? '📁' : entry.type === 'link' ? '🔗' : '📄'}
                          </span>
                          {openable ? (
                            <button type="button" className="link-button" onClick={() => open(entry)}>
                              {entry.name}
                            </button>
                          ) : (
                            <span>{entry.name}</span>
                          )}
                          {entry.type === 'link' && <span className="muted small"> (fuori dalla cartella)</span>}
                        </span>
                      )}
                    </td>
                    <td className="mono">{entry.type === 'file' ? formatBytes(entry.size) : ''}</td>
                    <td className="muted small">{formatDate(entry.modifiedAt)}</td>
                    <td>
                      {entry.type !== 'link' && (
                        <div className="btn-row nowrap">
                          <a className="btn btn-ghost btn-sm" href={downloadUrl(server.id, root, full)} download>
                            Scarica
                          </a>
                          {canModify(entry) && (
                            <>
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() => {
                                  setRenaming(entry.name)
                                  setNewName(entry.name)
                                }}
                              >
                                Rinomina
                              </button>
                              {confirmDelete === entry.name ? (
                                <>
                                  <button
                                    type="button"
                                    className="btn btn-danger btn-sm"
                                    onClick={() => run(actions.remove.mutateAsync({ root, path: full }), () => setConfirmDelete(null))}
                                  >
                                    Conferma
                                  </button>
                                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(null)}>
                                    Annulla
                                  </button>
                                </>
                              ) : (
                                <button type="button" className="btn btn-danger-outline btn-sm" onClick={() => setConfirmDelete(entry.name)}>
                                  Elimina
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
              {listing.data.entries.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    Cartella vuota. Trascina qui i file per caricarli.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">
        Gli elementi eliminati o sovrascritti finiscono nella scheda Cestino, dove restano per 30 giorni. Puoi trascinare
        file in questo riquadro per caricarli nella cartella corrente.
      </p>
    </div>
  )
}

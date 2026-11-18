import { type DragEvent, useRef, useState } from 'react'
import { formatBytes } from '../../lib/format'
import type { PluginUploadQueue } from './pluginUploadQueue'

/** Area di caricamento delle .dll, con l'avanzamento di ogni file. */
export default function PluginUpload({ queue }: { queue: PluginUploadQueue }) {
  const { items, busy, enable, setEnable, start } = queue
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    // La pagina ascolta i rilasci su tutta la finestra: questo lo gestisce già l'area
    e.stopPropagation()
    setDragging(false)
    if (!busy) void start([...e.dataTransfer.files])
  }

  return (
    <div>
      <div
        className={`dropzone ${dragging ? 'dropzone-active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p>
          <strong>Trascina qui i file .dll</strong> oppure{' '}
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => input.current?.click()}>
            Scegli file
          </button>
        </p>
        <p className="muted small">
          Se il plugin c'è già, la nuova versione si aggiunge alle altre e diventa quella in uso: le precedenti restano salvate e
          puoi tornarci da «Versioni». Le modifiche si applicano al riavvio del server.
        </p>
        <label className="checkbox">
          <input type="checkbox" checked={enable} onChange={(e) => setEnable(e.target.checked)} />
          Attiva i plugin nuovi dopo il caricamento
        </label>
        <input
          ref={input}
          type="file"
          accept=".dll"
          multiple
          hidden
          onChange={(e) => {
            void start([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
      </div>

      {items.length > 0 && (
        <ul className="upload-list">
          {items.map((item, i) => (
            <li key={`${item.file.name}-${i}`}>
              <div className="upload-row">
                <span>{item.file.name}</span>
                <span className="muted small">{formatBytes(item.file.size)}</span>
              </div>
              {item.status === 'uploading' && (
                <div className="progress">
                  <div style={{ width: `${Math.round(item.progress * 100)}%` }} />
                </div>
              )}
              {item.status === 'uploading' && item.progress >= 1 && <span className="muted small">Verifica in corso…</span>}
              {item.status === 'queued' && <span className="muted small">In coda</span>}
              {item.message && <span className={item.status === 'error' ? 'error-text' : 'small'}>{item.message}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

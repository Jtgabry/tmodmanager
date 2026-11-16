import { type DragEvent, useRef, useState } from 'react'
import { formatBytes } from '../../lib/format'
import type { UploadQueue } from './uploadQueue'

/** Caricamento di uno o più .tmod: area di rilascio, scelta dei file e avanzamento. */
export default function UploadZone({ queue }: { queue: UploadQueue }) {
  const { items, busy, enable, setEnable, start } = queue
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    // La pagina ascolta i rilasci su tutta la finestra: questo lo gestisce già l'area
    e.stopPropagation()
    setDragging(false)
    if (!busy) start([...e.dataTransfer.files])
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
          <strong>Trascina qui i file .tmod</strong> oppure{' '}
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => input.current?.click()}>
            Scegli file
          </button>
        </p>
        <p className="muted small">
          Se la mod esiste già viene aggiornata (la versione precedente va nell'archivio delle versioni). Le modifiche si applicano al
          riavvio del server.
        </p>
        <label className="checkbox">
          <input type="checkbox" checked={enable} onChange={(e) => setEnable(e.target.checked)} />
          Abilita le mod nuove dopo il caricamento
        </label>
        <input
          ref={input}
          type="file"
          accept=".tmod"
          multiple
          hidden
          onChange={(e) => {
            start([...(e.target.files ?? [])])
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

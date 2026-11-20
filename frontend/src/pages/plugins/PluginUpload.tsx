import { type DragEvent, useRef, useState } from 'react'
import { formatBytes } from '../../lib/format'
import type { PluginUploadQueue } from './pluginUploadQueue'
import { t } from '../../i18n'

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
          <strong>{t('Drag the .dll files here')}</strong> {t('or')}{' '}
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => input.current?.click()}>
            {t('Choose files')}
          </button>
        </p>
        <p className="muted small">
          {t(
            'If the plugin is already there, the new version is added to the others and becomes the one in use: the previous ones stay saved and you can go back to them from «Versions». Changes apply when the server restarts.',
          )}
        </p>
        <label className="checkbox">
          <input type="checkbox" checked={enable} onChange={(e) => setEnable(e.target.checked)} />
          {t('Activate new plugins after the upload')}
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
              {item.status === 'uploading' && item.progress >= 1 && <span className="muted small">{t('Checking…')}</span>}
              {item.status === 'queued' && <span className="muted small">{t('Queued')}</span>}
              {item.message && <span className={item.status === 'error' ? 'error-text' : 'small'}>{item.message}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { errorMessage, statusOf } from '../../lib/api'
import { readTextFile, saveTextFile } from '../../lib/files'
import { t } from '../../i18n'

/** Editor dei file di testo, con protezione dalle modifiche concorrenti (409 se il file è cambiato nel frattempo). */
export default function TextEditor(props: { serverId: string; root: string; path: string; onClose: () => void }) {
  const { serverId, root, path, onClose } = props
  const [content, setContent] = useState<string | null>(null)
  const [original, setOriginal] = useState('')
  const [modifiedAt, setModifiedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    readTextFile(serverId, root, path)
      .then((file) => {
        if (cancelled) return
        setContent(file.content)
        setOriginal(file.content)
        setModifiedAt(file.modifiedAt)
        setConflict(false)
        setError(null)
      })
      .catch((err) => !cancelled && setError(errorMessage(err)))
    return () => {
      cancelled = true
    }
  }, [serverId, root, path, reloadKey])

  const dirty = content !== null && content !== original

  const save = async () => {
    if (content === null) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const result = await saveTextFile(serverId, root, path, content, modifiedAt)
      setModifiedAt(result.modifiedAt)
      setOriginal(content)
      setSaved(true)
    } catch (err) {
      if (statusOf(err) === 409) setConflict(true)
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card editor">
      <div className="section-header">
        <h2 className="mono">{path}</h2>
        <div className="btn-row">
          <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || saving} onClick={save}>
            {saving ? t('Saving…') : t('Save')}
          </button>
          {conflict && (
            <button type="button" className="btn btn-sm" onClick={() => setReloadKey((k) => k + 1)}>
              {t('Reload (lose your changes)')}
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            {dirty ? t('Close without saving') : t('Close')}
          </button>
        </div>
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      {saved && !dirty && <div className="alert alert-success">{t('Saved. If it is a server configuration, it applies from the next restart.')}</div>}
      {content === null && !error && <div className="spinner" />}
      {content !== null && (
        <textarea
          className="editor-text"
          value={content}
          spellCheck={false}
          onChange={(e) => {
            setContent(e.target.value)
            setSaved(false)
          }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
              e.preventDefault()
              if (dirty) save()
            }
          }}
        />
      )}
    </div>
  )
}

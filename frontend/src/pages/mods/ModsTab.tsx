import { useEffect, useRef, useState } from 'react'
import Sheet from '../../components/Sheet'
import PageActions from '../../components/PageActions'
import { errorMessage } from '../../lib/api'
import { useCurrentServer } from '../../lib/currentServer'
import { useMods } from '../../lib/mods'
import { isUpdatable, useCancelJobItem, useModUpdates, useStartUpdate, useUpdateJob } from '../../lib/workshop'
import ModGrid from './ModGrid'
import UploadZone from './UploadZone'
import VersionArchive from './VersionArchive'
import { useUploadQueue } from './uploadQueue'
import WorkshopQueue from './WorkshopQueue'
import WorkshopUpdates from './WorkshopUpdates'

const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false

/**
 * Trascinamento di file su tutta la finestra: `dragging` mentre un file è sopra la pagina,
 * `onFiles` al rilascio. Il contatore serve perché dragenter/dragleave scattano su ogni elemento attraversato.
 */
function useWindowFileDrop(onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const onFilesRef = useRef(onFiles)

  useEffect(() => {
    onFilesRef.current = onFiles
  })

  useEffect(() => {
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current += 1
      setDragging(true)
    }
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return
      // Senza preventDefault il browser aprirebbe il file al rilascio
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setDragging(false)
      onFilesRef.current([...(e.dataTransfer?.files ?? [])])
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
      depth.current = 0
      setDragging(false)
    }
  }, [])

  return dragging
}

export default function ModsTab() {
  const server = useCurrentServer()
  const mods = useMods(server.id)
  const updates = useModUpdates(server.id)
  const job = useUpdateJob(server.id)
  const start = useStartUpdate(server.id)
  const cancel = useCancelJobItem(server.id)
  const queue = useUploadQueue(server.id)
  const [dialog, setDialog] = useState<'upload' | 'updates' | 'archive' | null>(null)

  // Un .tmod rilasciato ovunque nella pagina si carica (l'area della finestra "Carica mod" gestisce i suoi da sé)
  const dragging = useWindowFileDrop((files) => {
    setDialog('upload')
    void queue.start(files)
  })

  const list = mods.data?.mods ?? []
  const missingEnabled = mods.data?.missingEnabled ?? []
  const updatableCount = (updates.data?.mods ?? []).filter(isUpdatable).length
  const updating = job.data?.state === 'running' || start.isPending
  const enabledCount = list.filter((m) => m.enabled).length

  return (
    <div className="stack">
      <PageActions>
        {mods.data && (
          <span className="muted page-summary">
            {list.length} installate · {enabledCount} abilitate
          </span>
        )}
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => setDialog('archive')} title="Archivio delle versioni">
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="4" width="18" height="5" rx="1" />
              <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" />
              <path d="M10 13h4" />
            </svg>
            <span className="hide-narrow">Archivio</span>
          </button>
          <button type="button" className="btn" onClick={() => setDialog('updates')}>
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20 11a8 8 0 1 0-2.3 5.7" />
              <path d="M20 4v7h-7" />
            </svg>
            <span className="hide-narrow">{updating ? 'Aggiornamento…' : 'Aggiornamenti'}</span>
            {updatableCount > 0 && <span className="count-badge">{updatableCount}</span>}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setDialog('upload')}>
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 16V4" />
              <path d="M7 9l5-5 5 5" />
              <path d="M4 20h16" />
            </svg>
            Carica mod
          </button>
        </div>
      </PageActions>

      <WorkshopQueue server={server} />

      {cancel.error ? <div className="alert alert-error">{errorMessage(cancel.error)}</div> : null}
      {mods.isLoading && <div className="spinner" />}
      {mods.error && <div className="alert alert-error">{errorMessage(mods.error)}</div>}

      {missingEnabled.length > 0 && (
        <div className="alert alert-warning">
          In enabled.json risultano abilitate mod che non sono nella cartella: {missingEnabled.join(', ')}. tModLoader le ignorerà.
        </div>
      )}

      {mods.data && (
        <ModGrid
          serverId={server.id}
          mods={list}
          updates={updates.data}
          updating={start.isPending}
          onUpdate={(name) => start.mutate([name])}
          job={job.data}
          cancelling={cancel.isPending}
          onCancel={(name) => cancel.mutate(name)}
        />
      )}

      <Sheet open={dialog === 'upload'} title="Carica mod" keepMounted onClose={() => setDialog(null)}>
        <UploadZone queue={queue} />
      </Sheet>

      <Sheet open={dialog === 'archive'} title="Archivio delle versioni" wide onClose={() => setDialog(null)}>
        {dialog === 'archive' && <VersionArchive serverId={server.id} />}
      </Sheet>

      <Sheet open={dialog === 'updates'} title="Aggiornamenti dal Workshop" wide keepMounted onClose={() => setDialog(null)}>
        <WorkshopUpdates
          serverId={server.id}
          report={updates.data}
          loading={updates.isLoading}
          error={updates.error}
          job={job.data}
          starting={start.isPending}
          startError={start.error}
          onUpdate={(names) => start.mutate(names)}
        />
      </Sheet>

      {dragging && dialog !== 'upload' && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-box">
            <svg className="drop-overlay-icon" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 6.5a.5.5 0 0 1 .5.5v1.5H10a.5.5 0 0 1 0 1H8.5V11a.5.5 0 0 1-1 0V9.5H6a.5.5 0 0 1 0-1h1.5V7a.5.5 0 0 1 .5-.5" />
              <path d="M14 4.5V14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2h5.5zm-3 0A1.5 1.5 0 0 1 9.5 3V1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5z" />
            </svg>
            <strong>Rilascia per aggiungere la mod</strong>
            <span className="muted">File .tmod: se la mod c'è già viene aggiornata</span>
          </div>
        </div>
      )}
    </div>
  )
}

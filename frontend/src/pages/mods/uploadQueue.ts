import { useState } from 'react'
import { errorMessage } from '../../lib/api'
import { useUploadMod } from '../../lib/mods'

export type UploadItem = { file: File; progress: number; status: 'queued' | 'uploading' | 'done' | 'error'; message?: string }

export const isTmod = (file: File) => file.name.toLowerCase().endsWith('.tmod')

/**
 * Coda di caricamento dei .tmod (uno alla volta): nuove mod o aggiornamenti di quelle esistenti.
 * Sta nella pagina, così la si può avviare sia dalla finestra "Carica mod" sia trascinando i file ovunque.
 */
export function useUploadQueue(serverId: string) {
  const upload = useUploadMod(serverId)
  const [items, setItems] = useState<UploadItem[]>([])
  const [enable, setEnable] = useState(true)
  const busy = items.some((i) => i.status === 'uploading' || i.status === 'queued')

  const update = (index: number, patch: Partial<UploadItem>) =>
    setItems((list) => list.map((item, i) => (i === index ? { ...item, ...patch } : item)))

  const start = async (files: File[]) => {
    if (busy) return
    const tmods = files.filter(isTmod)
    const rejected = files.filter((f) => !isTmod(f))
    setItems([
      ...tmods.map((file): UploadItem => ({ file, progress: 0, status: 'queued' })),
      ...rejected.map((file): UploadItem => ({ file, progress: 0, status: 'error', message: 'Non è un file .tmod' })),
    ])

    for (const [index, file] of tmods.entries()) {
      update(index, { status: 'uploading' })
      try {
        const result = await upload.mutateAsync({ file, enable, onProgress: (p) => update(index, { progress: p }) })
        const label = result.mod.displayName ?? result.mod.name
        const message = result.replacedVersion
          ? `${label}: aggiornata da v${result.replacedVersion} a v${result.mod.version}`
          : `${label} v${result.mod.version} aggiunta`
        const others = result.enabled.filter((m) => m !== result.mod.name)
        const extra = others.length ? ` (abilitate anche: ${others.join(', ')})` : ''
        update(index, { status: 'done', progress: 1, message: (result.warning ?? message) + extra })
      } catch (err) {
        update(index, { status: 'error', message: errorMessage(err) })
      }
    }
  }

  return { items, busy, enable, setEnable, start }
}

export type UploadQueue = ReturnType<typeof useUploadQueue>

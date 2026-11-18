import { useState } from 'react'
import { errorMessage } from '../../lib/api'
import { pluginTitle, useUploadPlugin, versionLabel } from '../../lib/plugins'

type Item = { file: File; progress: number; status: 'queued' | 'uploading' | 'done' | 'error'; message?: string }

export const isDll = (file: File) => file.name.toLowerCase().endsWith('.dll')

/**
 * Coda di caricamento delle .dll (una alla volta). Sta nella pagina, così si avvia sia dalla finestra
 * "Carica plugin" sia trascinando i file ovunque.
 */
export function usePluginUploadQueue(serverId: string) {
  const upload = useUploadPlugin(serverId)
  const [items, setItems] = useState<Item[]>([])
  const [enable, setEnable] = useState(true)
  const busy = items.some((i) => i.status === 'uploading' || i.status === 'queued')

  const update = (index: number, patch: Partial<Item>) => setItems((list) => list.map((item, i) => (i === index ? { ...item, ...patch } : item)))

  const start = async (files: File[]) => {
    if (busy) return
    const dlls = files.filter(isDll)
    const rejected = files.filter((f) => !isDll(f))
    setItems([
      ...dlls.map((file): Item => ({ file, progress: 0, status: 'queued' })),
      ...rejected.map((file): Item => ({ file, progress: 0, status: 'error', message: 'Non è un file .dll' })),
    ])

    for (const [index, file] of dlls.entries()) {
      update(index, { status: 'uploading' })
      try {
        const r = await upload.mutateAsync({ file, enable, onProgress: (p) => update(index, { progress: p }) })
        const title = pluginTitle(r.plugin)
        const version = r.plugin.versions.find((v) => v.id === r.versionId)
        const label = version ? versionLabel(version) : ''
        const message = r.duplicate
          ? `${title} ${label}: questa versione era già salvata, ora è quella scelta`
          : r.previousVersion
            ? `${title}: aggiunta la ${label}, scelta al posto della ${versionLabel(r.previousVersion)} (che resta tra le versioni)`
            : r.plugin.versions.length > 1
              ? `${title}: aggiunta la ${label}`
              : `${title} ${label} aggiunto${r.plugin.enabled ? '' : ' (disattivato)'}`
        update(index, { status: 'done', progress: 1, message })
      } catch (err) {
        update(index, { status: 'error', message: errorMessage(err) })
      }
    }
  }

  return { items, busy, enable, setEnable, start }
}

export type PluginUploadQueue = ReturnType<typeof usePluginUploadQueue>

import type { UpdateJob, UpdateJobItem } from './types'

const FINISHED: UpdateJobItem['state'][] = ['done', 'skipped', 'error', 'cancelled']

/** Frazione della barra di una mod (null = indeterminata: dimensione ignota o primi dati non ancora arrivati). */
export const itemFraction = (item: UpdateJobItem): number | null => {
  if (FINISHED.includes(item.state) || item.state === 'installing') return 1
  if (item.state === 'queued') return 0
  // `!= null`: un agent non ancora aggiornato non manda proprio i campi dei byte
  return item.bytes != null && item.totalBytes ? Math.min(item.bytes / item.totalBytes, 0.99) : null
}

const ACTIVE: UpdateJobItem['state'][] = ['queued', 'downloading', 'installing']

/** Elemento del lavoro in corso che riguarda questa mod (in coda, in download o in installazione), se c'è. */
export function activeJobItem(job: UpdateJob | null | undefined, match: (item: UpdateJobItem) => boolean): UpdateJobItem | undefined {
  if (job?.state !== 'running') return undefined
  return job.items.find((i) => ACTIVE.includes(i.state) && match(i))
}

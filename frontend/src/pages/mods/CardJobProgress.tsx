import { formatBytes } from '../../lib/format'
import { itemFraction } from '../../lib/jobs'
import type { UpdateJobItem } from '../../lib/types'

function label(item: UpdateJobItem, fraction: number | null) {
  if (item.state === 'queued') return 'In coda'
  if (item.state === 'installing') return 'Installazione…'
  if (item.bytes == null) return 'Collegamento a Steam…'
  const size = item.totalBytes ? `${formatBytes(item.bytes)} / ${formatBytes(item.totalBytes)}` : formatBytes(item.bytes)
  return fraction === null ? `Download · ${size}` : `${Math.round(fraction * 100)}% · ${size}`
}

/**
 * Riga in fondo alla card durante un aggiornamento o un download: prende il posto dei pulsanti
 * con la stessa altezza (il pulsante "Annulla" ha la misura di quelli che sostituisce).
 */
export default function CardJobProgress({ item, cancelling, onCancel }: { item: UpdateJobItem; cancelling: boolean; onCancel: () => void }) {
  const fraction = itemFraction(item)
  const indeterminate = fraction === null || item.state === 'installing'
  return (
    <div className="mod-card-actions card-job">
      <div className="card-job-progress">
        <span className="card-job-label">{label(item, fraction)}</span>
        <div
          className="progress"
          role="progressbar"
          aria-label={`Avanzamento di ${item.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={indeterminate ? undefined : Math.round(fraction * 100)}
        >
          <div style={{ width: indeterminate ? '100%' : `${Math.max(fraction * 100, 2)}%` }} className={indeterminate ? 'indeterminate' : undefined} />
        </div>
      </div>
      <button
        type="button"
        className="btn btn-sm btn-icon btn-danger-outline"
        disabled={cancelling || item.state === 'installing'}
        onClick={onCancel}
        aria-label={`Annulla ${item.name}`}
        title={item.state === 'installing' ? "L'installazione non si può più annullare" : 'Annulla'}
      >
        <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  )
}

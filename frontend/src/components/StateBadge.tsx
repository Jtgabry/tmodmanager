import type { ServerState } from '../lib/types'

const LABELS: Record<ServerState, string> = {
  running: 'Acceso',
  starting: 'In avvio',
  stopping: 'In arresto',
  stopped: 'Spento',
}

export default function StateBadge({ state }: { state: ServerState }) {
  return (
    <span className={`badge badge-${state}`}>
      <span className="dot" />
      {LABELS[state]}
    </span>
  )
}

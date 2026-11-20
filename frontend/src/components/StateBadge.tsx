import type { ServerState } from '../lib/types'
import { t } from '../i18n'

const label = (state: ServerState): string =>
  ({
    running: t('Running'),
    starting: t('Starting'),
    stopping: t('Stopping'),
    stopped: t('Stopped'),
  })[state]

export default function StateBadge({ state }: { state: ServerState }) {
  return (
    <span className={`badge badge-${state}`}>
      <span className="dot" />
      {label(state)}
    </span>
  )
}

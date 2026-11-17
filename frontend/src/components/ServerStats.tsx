import { formatBytes, formatDuration } from '../lib/format'
import { GAME_LABEL, type Server } from '../lib/types'

/** `tiles`: ogni valore in un riquadro a sé (pagina Panoramica). */
export default function ServerStats({ server, tiles = false }: { server: Server; tiles?: boolean }) {
  const on = server.state !== 'stopped'
  return (
    <dl className={tiles ? 'stats stats-tiles' : 'stats'}>
      <div>
        <dt>Giocatori</dt>
        <dd>{on ? `${server.players.online} / ${server.players.max}` : '—'}</dd>
      </div>
      <div>
        <dt>CPU</dt>
        <dd>{server.cpuPercent !== null ? `${server.cpuPercent}%` : '—'}</dd>
      </div>
      <div>
        <dt>RAM</dt>
        <dd>{formatBytes(server.memoryBytes)}</dd>
      </div>
      <div>
        <dt>Uptime</dt>
        <dd>{formatDuration(server.uptimeSeconds)}</dd>
      </div>
      <div>
        <dt>Mondo</dt>
        <dd>{server.world ?? '—'}</dd>
      </div>
      <div>
        <dt>Porta</dt>
        <dd>{server.port}</dd>
      </div>
      <div>
        <dt>{GAME_LABEL[server.game]}</dt>
        <dd>{server.version ?? '—'}</dd>
      </div>
      {server.game === 'tmodloader' && (
        <div>
          <dt>Subworld</dt>
          <dd>{on ? server.subworlds : '—'}</dd>
        </div>
      )}
    </dl>
  )
}

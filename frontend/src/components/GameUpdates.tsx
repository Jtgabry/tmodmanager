import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAdminServerActions, useGameUpdates } from '../lib/admin'
import { errorMessage } from '../lib/api'
import { GAME_LABEL, type SwitchJob, type UpdateNotice } from '../lib/types'
import { t, tn } from '../i18n'

/**
 * Avvisi per gli amministratori dal controllo giornaliero degli aggiornamenti (fatto dall'agent al
 * massimo una volta al giorno): nuove versioni da installare, Terraria uscito prima di TShock (con il
 * passaggio temporaneo a vanilla) e ritorno su TShock quando arriva. Ogni avviso si può nascondere.
 */

const DISMISSED_KEY = 'tmm.dismissedUpdates'

function readDismissed(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as unknown
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function useDismissed() {
  const [dismissed, setDismissed] = useState(readDismissed)
  const dismiss = (id: string) => {
    const next = [...dismissed.filter((d) => d !== id), id].slice(-50)
    setDismissed(next)
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
    } catch {
      // senza localStorage resta nascosto solo fino al prossimo caricamento
    }
  }
  return { isDismissed: (id: string) => dismissed.includes(id), dismiss }
}

const names = (servers: { name: string }[]) => servers.map((s) => s.name).join(', ')

export default function GameUpdates() {
  const updates = useGameUpdates(true)
  const { isDismissed, dismiss } = useDismissed()
  if (!updates.data) return null

  const switches = updates.data.switches.filter((s) => !isDismissed(switchId(s)))
  const notices = updates.data.notices.filter((n) => !isDismissed(n.id))
  if (!switches.length && !notices.length) return null

  return (
    <div className="stack game-updates">
      {switches.map((job) => (
        <SwitchProgress key={switchId(job)} job={job} onClose={() => dismiss(switchId(job))} />
      ))}
      {notices.map((notice) => (
        <Notice key={notice.id} notice={notice} switches={updates.data.switches} onDismiss={() => dismiss(notice.id)} />
      ))}
    </div>
  )
}

const switchId = (job: SwitchJob) => `switch:${job.serverId}:${job.startedAt}`

function SwitchProgress({ job, onClose }: { job: SwitchJob; onClose: () => void }) {
  const running = job.phase !== 'done' && job.phase !== 'error'
  return (
    <div className={`alert ${job.phase === 'error' ? 'alert-error' : running ? 'alert-info' : 'alert-success'}`} role="status">
      <p>
        {running && <strong>{job.serverName} → {GAME_LABEL[job.to]}: </strong>}
        {job.message}
        {job.error && <> — {job.error}</>}
      </p>
      {running && <div className="progress progress-indeterminate"><div /></div>}
      {!running && (
        <div className="btn-row">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            {t('Close')}
          </button>
        </div>
      )}
    </div>
  )
}

function Notice({ notice, switches, onDismiss }: { notice: UpdateNotice; switches: SwitchJob[]; onDismiss: () => void }) {
  const busy = (id: string) => switches.some((s) => s.serverId === id && s.phase !== 'done' && s.phase !== 'error')
  if (notice.type === 'update') return <UpdateAvailable notice={notice} busy={busy} onDismiss={onDismiss} />
  if (notice.type === 'server-update') return busy(notice.server.id) ? null : <ServerUpdate notice={notice} onDismiss={onDismiss} />
  if (notice.type === 'tshock-behind') {
    const servers = notice.servers.filter((s) => !busy(s.id))
    return servers.length ? <TshockBehind notice={{ ...notice, servers }} onDismiss={onDismiss} /> : null
  }
  return busy(notice.server.id) ? null : <TshockReady notice={notice} onDismiss={onDismiss} />
}

const releaseNotes = (url: string | null | undefined) =>
  url && (
    <a href={url} target="_blank" rel="noreferrer">
      {t('Release notes')}
    </a>
  )

function UpdateAvailable({
  notice,
  busy,
  onDismiss,
}: {
  notice: Extract<UpdateNotice, { type: 'update' }>
  busy: (serverId: string) => boolean
  onDismiss: () => void
}) {
  const { updateTml, switchGame } = useAdminServerActions()
  const [confirm, setConfirm] = useState(false)
  // Aggiornamento di un server solo: passa a una versione fissa nuova (gli altri restano sulla principale)
  const [single, setSingle] = useState<string | null>(null)
  const singleServer = notice.servers.find((s) => s.id === single)
  const others = notice.servers.filter((s) => !busy(s.id))
  const label = GAME_LABEL[notice.game]
  const forTerraria = notice.game !== 'terraria' && notice.gameVersion ? ` ${t('(for Terraria {version})', { version: notice.gameVersion })}` : ''

  if (updateTml.isSuccess) {
    return (
      <div className="alert alert-info">
        {tn('Update of {game} to {version} started. Progress is shown in {link}.', {
          game: label,
          version: notice.to,
          link: <Link to="/admin/servers">{t('Server management')}</Link>,
        })}
      </div>
    )
  }

  return (
    <div className="alert alert-info">
      <p>
        {tn('{release} is available', { release: <strong>{label} {notice.to}</strong> })}
        {forTerraria} — {t('{version} installed', { version: notice.from ?? '?' })}
        {notice.servers.length > 0 ? t(', used by {servers}', { servers: names(notice.servers) }) : t(', no server uses it')}.{' '}
        {releaseNotes(notice.url)}
      </p>
      {singleServer && (
        <p className="small">
          {tn(
            'Only {server} moves to {game} {version}, installed as a pinned version; the other servers stay on {current}. If it is running it is stopped (saving the world) and started again.',
            {
              server: <strong>{singleServer.name}</strong>,
              game: label,
              version: notice.to,
              current: notice.from ?? t('the current version'),
            },
          )}
        </p>
      )}
      {confirm && (
        <p className="small">
          {notice.servers.length > 0
            ? `${t('All the servers that use it are updated ({servers}): the running ones are stopped (saving the world) and started again at the end.', { servers: names(notice.servers) })} `
            : ''}
          {notice.game === 'tmodloader'
            ? t('Mods might need an update for the new version.')
            : t('Players need the same Terraria version as the server to join.')}
        </p>
      )}
      <div className="btn-row">
        {singleServer ? (
          <>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={switchGame.isPending}
              onClick={() =>
                switchGame.mutate({ id: singleServer.id, game: notice.game, version: notice.to }, { onSettled: () => setSingle(null) })
              }
            >
              {t('Confirm: update only {server}', { server: singleServer.name })}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSingle(null)}>
              {t('Cancel')}
            </button>
          </>
        ) : confirm ? (
          <>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={updateTml.isPending}
              onClick={() => updateTml.mutate({ id: notice.installation, version: notice.to, restartServers: true })}
            >
              {t('Confirm update')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(false)}>
              {t('Cancel')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setConfirm(true)}>
              {notice.servers.length > 1 ? t('Update {game} for all', { game: label }) : t('Update {game}', { game: label })}
            </button>
            {notice.servers.length > 1 &&
              others.map((s) => (
                <button key={s.id} type="button" className="btn btn-sm" onClick={() => setSingle(s.id)}>
                  {t('Update only {server}', { server: s.name })}
                </button>
              ))}
            <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}>
              {t('Hide')}
            </button>
          </>
        )}
      </div>
      {updateTml.isError && <p className="error-text">{errorMessage(updateTml.error)}</p>}
      {switchGame.isError && <p className="error-text">{errorMessage(switchGame.error)}</p>}
    </div>
  )
}

/** Server su una versione fissa: si aggiorna da solo passando alla versione nuova (installata come fissa). */
function ServerUpdate({ notice, onDismiss }: { notice: Extract<UpdateNotice, { type: 'server-update' }>; onDismiss: () => void }) {
  const { switchGame } = useAdminServerActions()
  const [confirm, setConfirm] = useState(false)
  const label = GAME_LABEL[notice.game]
  const forTerraria = notice.game !== 'terraria' && notice.gameVersion ? ` ${t('(for Terraria {version})', { version: notice.gameVersion })}` : ''

  return (
    <div className="alert alert-info">
      <p>
        {tn('{release} is available', { release: <strong>{label} {notice.to}</strong> })}
        {forTerraria}{' '}
        {tn('for {server}, which is on the pinned version {version}.', {
          server: <strong>{notice.server.name}</strong>,
          version: notice.from,
        })}{' '}
        {releaseNotes(notice.url)}
      </p>
      {confirm && (
        <p className="small">
          {t(
            '{game} {version} is installed as a pinned version (if not there already) and only this server moves to it. If it is running it is stopped (saving the world) and started again.',
            { game: label, version: notice.to },
          )}
          {notice.game === 'tmodloader' && ` ${t('Mods might need an update for the new version.')}`}
        </p>
      )}
      <div className="btn-row">
        {confirm ? (
          <>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={switchGame.isPending}
              onClick={() => switchGame.mutate({ id: notice.server.id, game: notice.game, version: notice.to }, { onSettled: () => setConfirm(false) })}
            >
              {t('Confirm update')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(false)}>
              {t('Cancel')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setConfirm(true)}>
              {t('Update {server}', { server: notice.server.name })}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}>
              {t('Hide')}
            </button>
          </>
        )}
      </div>
      {switchGame.isError && <p className="error-text">{errorMessage(switchGame.error)}</p>}
    </div>
  )
}

function TshockBehind({ notice, onDismiss }: { notice: Extract<UpdateNotice, { type: 'tshock-behind' }>; onDismiss: () => void }) {
  const { switchGame } = useAdminServerActions()
  const [confirm, setConfirm] = useState<string | null>(null)
  const target = notice.servers.find((s) => s.id === confirm)

  return (
    <div className="alert alert-warning">
      <p>
        {tn(
          '{release} is out, but TShock still supports Terraria {supported}: whoever already updated the game cannot join {servers}.',
          {
            release: <strong>Terraria {notice.terrariaVersion}</strong>,
            supported: notice.tshockGameVersion ?? '?',
            servers: names(notice.servers),
          },
        )}
      </p>
      <p className="small">
        {t(
          'Meanwhile you can switch the server to vanilla Terraria {version}. World, TShock data and plugins stay where they are (plugins are inactive while the server is vanilla), and when an updated TShock comes out a button to switch back appears here.',
          { version: notice.terrariaVersion },
        )}
      </p>
      {target && (
        <p className="small">
          {tn(
            '{server}, if running, is stopped saving the world and started again on vanilla. If you use characters saved on the server (TShock SSC), on vanilla everyone joins with their local character.',
            { server: <strong>{target.name}</strong> },
          )}
        </p>
      )}
      <div className="btn-row">
        {target ? (
          <>
            <button
              type="button"
              className="btn btn-warning btn-sm"
              disabled={switchGame.isPending}
              onClick={() => switchGame.mutate({ id: target.id, game: 'terraria' }, { onSettled: () => setConfirm(null) })}
            >
              {t('Confirm: switch to Terraria {version}', { version: notice.terrariaVersion })}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>
              {t('Cancel')}
            </button>
          </>
        ) : (
          <>
            {notice.servers.map((s) => (
              <button key={s.id} type="button" className="btn btn-warning btn-sm" onClick={() => setConfirm(s.id)}>
                {notice.servers.length > 1
                  ? t('Switch «{server}» to Terraria {version}', { server: s.name, version: notice.terrariaVersion })
                  : t('Switch to Terraria {version}', { version: notice.terrariaVersion })}
              </button>
            ))}
            <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}>
              {t('Hide')}
            </button>
          </>
        )}
      </div>
      {switchGame.isError && <p className="error-text">{errorMessage(switchGame.error)}</p>}
    </div>
  )
}

function TshockReady({ notice, onDismiss }: { notice: Extract<UpdateNotice, { type: 'tshock-ready' }>; onDismiss: () => void }) {
  const { switchGame, stayVanilla } = useAdminServerActions()
  const [confirm, setConfirm] = useState(false)

  return (
    <div className="alert alert-success">
      <p>
        {tn('{release} supports Terraria {version}: {server} can go back to TShock, with its data and plugins.', {
          release: <strong>TShock {notice.tshockVersion}</strong>,
          version: notice.tshockGameVersion,
          server: <strong>{notice.server.name}</strong>,
        })}
      </p>
      {confirm && (
        <p className="small">
          {notice.needsUpdate &&
            `${t('First TShock {version} is installed (the other running TShock servers are restarted).', { version: notice.tshockVersion })} `}
          {t('The server, if running, is stopped saving the world and started again on TShock.')}
        </p>
      )}
      <div className="btn-row">
        {confirm ? (
          <>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={switchGame.isPending}
              onClick={() => switchGame.mutate({ id: notice.server.id, game: 'tshock' }, { onSettled: () => setConfirm(false) })}
            >
              {t('Confirm: go back to TShock')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(false)}>
              {t('Cancel')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setConfirm(true)}>
              {t('Move back to TShock')}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={stayVanilla.isPending}
              title={t("Don't suggest it again for this server")}
              onClick={() => stayVanilla.mutate(notice.server.id, { onSuccess: onDismiss })}
            >
              {t('Stay on vanilla')}
            </button>
          </>
        )}
      </div>
      {(switchGame.isError || stayVanilla.isError) && <p className="error-text">{errorMessage(switchGame.error ?? stayVanilla.error)}</p>}
    </div>
  )
}

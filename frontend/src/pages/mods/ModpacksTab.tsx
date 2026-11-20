import { type FormEvent, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import Sheet from '../../components/Sheet'
import OverflowActions, { type OverflowAction } from '../../components/OverflowActions'
import PageActions from '../../components/PageActions'
import { errorMessage } from '../../lib/api'
import { useCurrentServer } from '../../lib/currentServer'
import { formatBytes } from '../../lib/format'
import { packState, packModsOf, packSize } from '../../lib/modpacks'
import { useDeleteModpack, useModpacks, useMods, useSaveModpack } from '../../lib/mods'
import type { Mod, Modpack } from '../../lib/types'
import ExportPackSheet from './ExportPackSheet'
import ModpackImport from './ModpackImport'
import { usePackActivation } from './usePackActivation'
import PackCover from './PackCover'
import { t, tn } from '../../i18n'

type Show = 'all' | 'on' | 'off'

/** Pagina Modpack: griglia dei pack (copertina ricavata dalle mod), creazione e importazione. */
export default function ModpacksTab() {
  const server = useCurrentServer()
  const navigate = useNavigate()
  const mods = useMods(server.id)
  const packs = useModpacks(server.id)
  const remove = useDeleteModpack(server.id)
  const [dialog, setDialog] = useState<'new' | 'import' | null>(null)
  const [deleting, setDeleting] = useState<Modpack | null>(null)
  const [exporting, setExporting] = useState<Modpack | null>(null)
  const [query, setQuery] = useState('')
  const [show, setShow] = useState<Show>('all')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const byName = useMemo(() => new Map((mods.data?.mods ?? []).map((m) => [m.name, m])), [mods.data])
  const list = packs.data ?? []
  const activeCount = list.filter((p) => p.active).length
  const visible = list.filter((p) => {
    if (show === 'on' && !p.active) return false
    if (show === 'off' && p.active) return false
    const q = query.trim().toLowerCase()
    return !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
  })

  const onResult = (n: string | null, e: string | null) => {
    setNotice(n)
    setError(e)
  }

  if (mods.isLoading || packs.isLoading) return <div className="spinner" />
  if (mods.error || packs.error) return <div className="alert alert-error">{errorMessage(mods.error ?? packs.error)}</div>

  return (
    <div className="stack">
      <PageActions>
        <span className="muted page-summary">
          {t('{count} modpacks', { count: list.length })} · {activeCount === 1 ? t('1 active') : t('{count} active', { count: activeCount })}
        </span>
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => setDialog('import')}>
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 4v12" />
              <path d="M7 11l5 5 5-5" />
              <path d="M4 20h16" />
            </svg>
            <span className="hide-narrow">{t('Import from tModLoader')}</span>
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setDialog('new')}>
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            {t('New modpack')}
          </button>
        </div>
      </PageActions>

      {list.length > 0 && (
        <div className="mods-toolbar">
          <label className="search-box">
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <input type="search" placeholder={t('Search a modpack…')} aria-label={t('Search a modpack')} value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="segmented" role="group" aria-label={t('Modpack status')}>
            {(
              [
                ['all', t('All'), list.length],
                ['on', t('Active|packs'), activeCount],
                ['off', t('Inactive|packs'), list.length - activeCount],
              ] as const
            ).map(([value, label, count]) => (
              <button key={value} type="button" className={show === value ? 'active' : ''} aria-pressed={show === value} onClick={() => setShow(value)}>
                {label} {count}
              </button>
            ))}
          </div>
        </div>
      )}

      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      {list.length === 0 ? (
        <div className="empty">
          {t('No modpacks. A modpack is a group of mods to activate or deactivate together, even at specific versions.')}
        </div>
      ) : visible.length === 0 ? (
        <div className="empty">{t('No modpack matches the filters.')}</div>
      ) : (
        <div className="mod-grid">
          {visible.map((pack) => (
            <PackCard
              key={pack.id}
              serverId={server.id}
              pack={pack}
              packs={list}
              byName={byName}
              onOpen={() => navigate(pack.id)}
              onResult={onResult}
              onDelete={() => setDeleting(pack)}
              onExport={() => setExporting(pack)}
            />
          ))}
        </div>
      )}

      <Sheet open={dialog === 'new'} title={t('New modpack')} onClose={() => setDialog(null)}>
        {dialog === 'new' && <NewPackForm serverId={server.id} onCancel={() => setDialog(null)} onCreated={(id) => navigate(id)} />}
      </Sheet>

      <Sheet open={dialog === 'import'} title={t('Import from tModLoader')} wide onClose={() => setDialog(null)}>
        {dialog === 'import' && <ModpackImport serverId={server.id} inDialog onClose={() => setDialog(null)} />}
      </Sheet>

      <ExportPackSheet serverId={server.id} pack={exporting} onClose={() => setExporting(null)} />

      <Sheet open={deleting !== null} title={t('Delete the modpack?')} onClose={() => setDeleting(null)}>
        {deleting && (
          <div className="stack">
            <p>
              {tn('{pack} will be deleted. The mods stay installed as they are.', { pack: <strong>{deleting.name}</strong> })}
            </p>
            {remove.error ? <div className="alert alert-error">{errorMessage(remove.error)}</div> : null}
            <div className="btn-row">
              <button type="button" className="btn btn-danger" disabled={remove.isPending} onClick={() => remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}>
                {t('Delete')}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setDeleting(null)}>
                {t('Cancel')}
              </button>
            </div>
          </div>
        )}
      </Sheet>
    </div>
  )
}

/** Modal di creazione: solo il nome. Il resto si fa nella pagina del modpack, che si apre subito. */
function NewPackForm({ serverId, onCancel, onCreated }: { serverId: string; onCancel: () => void; onCreated: (id: string) => void }) {
  const save = useSaveModpack(serverId)
  const [name, setName] = useState('')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate({ name: name.trim(), description: '', mods: [], versions: {} }, { onSuccess: (pack) => onCreated(pack.id) })
  }

  return (
    <form className="stack" onSubmit={submit}>
      <label className="field">
        <span>{t('Name')}</span>
        <input required autoFocus maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <p className="muted small">{t('After creating it the modpack page opens, where you add the mods and the description.')}</p>
      {save.error ? <div className="alert alert-error">{errorMessage(save.error)}</div> : null}
      <div className="btn-row btn-row-end">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          {t('Cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={save.isPending || !name.trim()}>
          {save.isPending ? t('Creating…') : t('Create modpack')}
        </button>
      </div>
    </form>
  )
}

function PackCard(props: {
  serverId: string
  pack: Modpack
  packs: Modpack[]
  byName: Map<string, Mod>
  onOpen: () => void
  onResult: (notice: string | null, error: string | null) => void
  onDelete: () => void
  onExport: () => void
}) {
  const { pack, byName } = props
  const state = packState(pack.state)
  const problems = pack.missing.length + pack.unavailable.length
  const blocked = pack.mods.length === 0 || problems > 0
  const activation = usePackActivation({ ...props, blocked })

  const exportIcon = (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4v12" />
      <path d="M7 11l5 5 5-5" />
      <path d="M4 20h16" />
    </svg>
  )
  const deleteIcon = (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M9 7V4h6v3" />
    </svg>
  )
  const toggleLabel = activation.busy ? t('One moment…') : pack.active ? t('Deactivate') : t('Activate')
  const toggleDisabled = activation.busy || (!pack.active && blocked)

  // In ordine di importanza: se la card è stretta, i meno importanti finiscono nel menu «⋯»
  const actions: OverflowAction[] = [
    {
      key: 'toggle',
      priority: 4,
      label: toggleLabel,
      disabled: toggleDisabled,
      onSelect: activation.toggle,
      inline: (
        <button type="button" className={pack.active ? 'btn btn-sm btn-toggle-on' : 'btn btn-sm'} disabled={toggleDisabled} onClick={activation.toggle}>
          {toggleLabel}
        </button>
      ),
    },
    ...(activation.exclusiveUseful
      ? [
          {
            key: 'exclusive',
            priority: 3,
            label: t('Activate only this one'),
            disabled: activation.busy || blocked,
            onSelect: activation.exclusive,
            inline: (
              <button
                type="button"
                className="btn btn-sm"
                disabled={activation.busy || blocked}
                title={t('Enables only the mods of this pack and disables all the others')}
                onClick={activation.exclusive}
              >
                {t('Only this one')}
              </button>
            ),
          },
        ]
      : []),
    {
      key: 'export',
      priority: 1,
      end: true,
      label: t('Export'),
      icon: exportIcon,
      disabled: pack.mods.length === 0,
      onSelect: props.onExport,
      inline: (
        <button
          type="button"
          className="btn btn-sm btn-icon"
          aria-label={t('Export {name}', { name: pack.name })}
          title={t('Export: modpack folder (.zip) or list of mods (.json)')}
          disabled={pack.mods.length === 0}
          onClick={props.onExport}
        >
          {exportIcon}
        </button>
      ),
    },
    {
      key: 'delete',
      priority: 2,
      end: true,
      danger: true,
      label: t('Delete'),
      icon: deleteIcon,
      onSelect: props.onDelete,
      inline: (
        <button type="button" className="btn btn-sm btn-icon btn-danger-outline" aria-label={t('Delete {name}', { name: pack.name })} title={t('Delete')} onClick={props.onDelete}>
          {deleteIcon}
        </button>
      ),
    },
  ]

  return (
    <article className="mod-card pack-card" onClick={props.onOpen}>
      <div className="mod-card-head">
        <PackCover serverId={props.serverId} packMods={packModsOf(pack, byName)} />
        <div className="mod-card-heading">
          <h3 className="mod-title">
            <Link to={pack.id} className="link-button" onClick={(e) => e.stopPropagation()}>
              {pack.name}
            </Link>
          </h3>
          <div className="mod-author">
            {pack.mods.length === 0 ? t('No mods') : `${t('{count} mods', { count: pack.mods.length })} · ${formatBytes(packSize(pack, byName))}`}
          </div>
          <div className="pill-row">
            <span className={state.className}>{state.text}</span>
            {problems > 0 && <span className="pill pill-warning">{problems === 1 ? t('1 mod to fix') : t('{count} mods to fix', { count: problems })}</span>}
          </div>
        </div>
      </div>

      {pack.description ? (
        <p className="mod-description-short pack-card-description">{pack.description}</p>
      ) : (
        <p className="mod-description-short pack-card-description pack-card-placeholder">{t('No description: add it from the modpack page.')}</p>
      )}

      <OverflowActions actions={actions} menuLabel={t('More actions for {name}', { name: pack.name })} />
      {activation.dialog}
    </article>
  )
}

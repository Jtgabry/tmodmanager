import { type FormEvent, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import Sheet from '../../components/Sheet'
import OverflowActions, { type OverflowAction } from '../../components/OverflowActions'
import PageActions from '../../components/PageActions'
import { errorMessage } from '../../lib/api'
import { useCurrentServer } from '../../lib/currentServer'
import { formatBytes } from '../../lib/format'
import { PACK_STATE, packModsOf, packSize } from '../../lib/modpacks'
import { useDeleteModpack, useModpacks, useMods, useSaveModpack } from '../../lib/mods'
import type { Mod, Modpack } from '../../lib/types'
import ExportPackSheet from './ExportPackSheet'
import ModpackImport from './ModpackImport'
import { usePackActivation } from './usePackActivation'
import PackCover from './PackCover'

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
          {list.length} modpack · {activeCount} {activeCount === 1 ? 'attivo' : 'attivi'}
        </span>
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => setDialog('import')}>
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 4v12" />
              <path d="M7 11l5 5 5-5" />
              <path d="M4 20h16" />
            </svg>
            <span className="hide-narrow">Importa da tModLoader</span>
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setDialog('new')}>
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Nuovo modpack
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
            <input type="search" placeholder="Cerca un modpack…" aria-label="Cerca un modpack" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="segmented" role="group" aria-label="Stato dei modpack">
            {(
              [
                ['all', 'Tutti', list.length],
                ['on', 'Attivi', activeCount],
                ['off', 'Disattivi', list.length - activeCount],
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
          Nessun modpack. Un modpack è un gruppo di mod da attivare o disattivare insieme, anche a versioni precise.
        </div>
      ) : visible.length === 0 ? (
        <div className="empty">Nessun modpack corrisponde ai filtri.</div>
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

      <Sheet open={dialog === 'new'} title="Nuovo modpack" onClose={() => setDialog(null)}>
        {dialog === 'new' && <NewPackForm serverId={server.id} onCancel={() => setDialog(null)} onCreated={(id) => navigate(id)} />}
      </Sheet>

      <Sheet open={dialog === 'import'} title="Importa da tModLoader" wide onClose={() => setDialog(null)}>
        {dialog === 'import' && <ModpackImport serverId={server.id} inDialog onClose={() => setDialog(null)} />}
      </Sheet>

      <ExportPackSheet serverId={server.id} pack={exporting} onClose={() => setExporting(null)} />

      <Sheet open={deleting !== null} title="Eliminare il modpack?" onClose={() => setDeleting(null)}>
        {deleting && (
          <div className="stack">
            <p>
              <strong>{deleting.name}</strong> verrà eliminato. Le mod restano installate così come sono.
            </p>
            {remove.error ? <div className="alert alert-error">{errorMessage(remove.error)}</div> : null}
            <div className="btn-row">
              <button type="button" className="btn btn-danger" disabled={remove.isPending} onClick={() => remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}>
                Elimina
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setDeleting(null)}>
                Annulla
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
        <span>Nome</span>
        <input required autoFocus maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <p className="muted small">Dopo la creazione si apre la pagina del modpack, dove aggiungere le mod e la descrizione.</p>
      {save.error ? <div className="alert alert-error">{errorMessage(save.error)}</div> : null}
      <div className="btn-row btn-row-end">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Annulla
        </button>
        <button type="submit" className="btn btn-primary" disabled={save.isPending || !name.trim()}>
          {save.isPending ? 'Creazione…' : 'Crea modpack'}
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
  const state = PACK_STATE[pack.state]
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
  const toggleLabel = activation.busy ? 'Un momento…' : pack.active ? 'Disattiva' : 'Attiva'
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
            label: 'Attiva solo questo',
            disabled: activation.busy || blocked,
            onSelect: activation.exclusive,
            inline: (
              <button
                type="button"
                className="btn btn-sm"
                disabled={activation.busy || blocked}
                title="Abilita solo le mod di questo pack e disabilita tutte le altre"
                onClick={activation.exclusive}
              >
                Solo questo
              </button>
            ),
          },
        ]
      : []),
    {
      key: 'export',
      priority: 1,
      end: true,
      label: 'Esporta',
      icon: exportIcon,
      disabled: pack.mods.length === 0,
      onSelect: props.onExport,
      inline: (
        <button
          type="button"
          className="btn btn-sm btn-icon"
          aria-label={`Esporta ${pack.name}`}
          title="Esporta: cartella del modpack (.zip) o elenco delle mod (.json)"
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
      label: 'Elimina',
      icon: deleteIcon,
      onSelect: props.onDelete,
      inline: (
        <button type="button" className="btn btn-sm btn-icon btn-danger-outline" aria-label={`Elimina ${pack.name}`} title="Elimina" onClick={props.onDelete}>
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
            {pack.mods.length === 0 ? 'Nessuna mod' : `${pack.mods.length} mod · ${formatBytes(packSize(pack, byName))}`}
          </div>
          <div className="pill-row">
            <span className={state.className}>{state.text}</span>
            {problems > 0 && <span className="pill pill-warning">{problems === 1 ? '1 mod da sistemare' : `${problems} mod da sistemare`}</span>}
          </div>
        </div>
      </div>

      {pack.description ? (
        <p className="mod-description-short pack-card-description">{pack.description}</p>
      ) : (
        <p className="mod-description-short pack-card-description pack-card-placeholder">Nessuna descrizione: aggiungila dalla pagina del modpack.</p>
      )}

      <OverflowActions actions={actions} menuLabel={`Altre azioni per ${pack.name}`} />
      {activation.dialog}
    </article>
  )
}

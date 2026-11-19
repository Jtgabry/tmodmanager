import { useMemo, useState } from 'react'
import Sheet from '../../components/Sheet'
import { errorMessage } from '../../lib/api'
import { formatBytes, formatDate } from '../../lib/format'
import { conflictDetails, modDownloadUrl, useDeleteMod, useToggleMod, workshopCategories } from '../../lib/mods'
import { isUpdatable } from '../../lib/workshop'
import type { Mod, ModUpdate, UpdateJob, UpdateJobItem, UpdateReport } from '../../lib/types'
import { activeJobItem } from '../../lib/jobs'
import CardJobProgress from './CardJobProgress'
import OverflowActions, { type OverflowAction } from '../../components/OverflowActions'
import ModIcon from './ModIcon'
import VersionArchive from './VersionArchive'
import WorkshopLinkEditor from './WorkshopLinkEditor'

const SIDE_LABEL: Record<string, string> = { both: 'Client e server', client: 'Solo client', server: 'Solo server', noSync: 'No sync' }

type Show = 'all' | 'on' | 'off' | 'updates'
type Pending = { kind: 'disable'; mod: Mod; dependents: string[] } | { kind: 'delete'; mod: Mod; dependents: string[] | null }

const titleOf = (mod: Mod) => mod.displayName ?? mod.name

/** Lista delle mod a griglia: ricerca, filtri per stato e per tag, card con le azioni. */
export default function ModGrid({
  serverId,
  mods,
  updates,
  updating,
  onUpdate,
  job,
  cancelling,
  onCancel,
}: {
  serverId: string
  mods: Mod[]
  updates: UpdateReport | undefined
  updating: boolean
  onUpdate: (name: string) => void
  /** Lavoro di download in corso: le mod che vi compaiono mostrano la barra al posto dei pulsanti. */
  job: UpdateJob | null | undefined
  cancelling: boolean
  onCancel: (name: string) => void
}) {
  const toggle = useToggleMod(serverId)
  const remove = useDeleteMod(serverId)
  const [query, setQuery] = useState('')
  const [show, setShow] = useState<Show>('all')
  const [tag, setTag] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [details, setDetails] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const updateOf = useMemo(() => new Map((updates?.mods ?? []).map((u) => [u.name, u])), [updates])
  const categoriesOf = useMemo(() => new Map(mods.map((m) => [m.name, workshopCategories(m.workshop?.tags)])), [mods])

  const counts = useMemo(
    () => ({
      all: mods.length,
      on: mods.filter((m) => m.enabled).length,
      off: mods.filter((m) => !m.enabled).length,
      updates: mods.filter((m) => isUpdatable(updateOf.get(m.name))).length,
    }),
    [mods, updateOf],
  )

  /** Tag presenti, dal più usato. */
  const tagCounts = useMemo(() => {
    const count = new Map<string, number>()
    for (const tags of categoriesOf.values()) for (const t of tags) count.set(t, (count.get(t) ?? 0) + 1)
    return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [categoriesOf])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return mods
      .filter((m) => {
        if (show === 'on' && !m.enabled) return false
        if (show === 'off' && m.enabled) return false
        if (show === 'updates' && !isUpdatable(updateOf.get(m.name))) return false
        const tags = categoriesOf.get(m.name) ?? []
        if (tag && !tags.includes(tag)) return false
        return !q || [m.name, m.displayName, m.author, ...tags].some((v) => v?.toLowerCase().includes(q))
      })
      .sort((a, b) => titleOf(a).localeCompare(titleOf(b)))
  }, [mods, query, show, tag, updateOf, categoriesOf])

  const nameOf = (name: string) => mods.find((m) => m.name === name)?.displayName ?? name
  const list = (names: string[]) => names.map(nameOf).join(', ')
  const busy = toggle.isPending || remove.isPending

  const onToggle = (mod: Mod, cascade = false) => {
    setError(null)
    setNotice(null)
    toggle.mutate(
      { name: mod.name, enabled: !mod.enabled, cascade },
      {
        onSuccess: (r) => {
          setPending(null)
          const extraOn = r.enabled.filter((n) => n !== mod.name)
          const extraOff = r.disabled.filter((n) => n !== mod.name)
          if (extraOn.length) setNotice(`Abilitate anche le dipendenze: ${list(extraOn)}`)
          if (extraOff.length) setNotice(`Disabilitate anche: ${list(extraOff)}`)
        },
        onError: (err) => {
          const conflict = conflictDetails(err)
          // Disabilitando una mod da cui altre dipendono: si chiede conferma per disabilitarle tutte
          if (mod.enabled && conflict?.dependents) setPending({ kind: 'disable', mod, dependents: conflict.dependents })
          else setError(errorMessage(err))
        },
      },
    )
  }

  const onDelete = (mod: Mod, cascade = false) => {
    setError(null)
    setNotice(null)
    remove.mutate(
      { name: mod.name, cascade },
      {
        onSuccess: (r) => {
          setPending(null)
          const extra = r.disabled.filter((n) => n !== mod.name)
          setNotice(`${titleOf(mod)} spostata nel cestino${extra.length ? `; disabilitate anche: ${list(extra)}` : ''}.`)
        },
        onError: (err) => {
          const conflict = conflictDetails(err)
          if (conflict?.dependents) setPending({ kind: 'delete', mod, dependents: conflict.dependents })
          else {
            setPending(null)
            setError(errorMessage(err))
          }
        },
      },
    )
  }

  const detailsMod = details ? mods.find((m) => m.name === details) : undefined
  const filters: { value: Show; label: string }[] = [
    { value: 'all', label: 'Tutte' },
    { value: 'on', label: 'Abilitate' },
    { value: 'off', label: 'Disabilitate' },
    ...(counts.updates > 0 || show === 'updates' ? [{ value: 'updates' as const, label: 'Da aggiornare' }] : []),
  ]

  return (
    <div className="stack">
      <div className="mods-toolbar">
        <label className="search-box">
          <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            type="search"
            placeholder="Cerca per nome, autore o tag…"
            aria-label="Cerca mod"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="segmented" role="group" aria-label="Stato delle mod">
          {filters.map((f) => (
            <button key={f.value} type="button" className={show === f.value ? 'active' : ''} aria-pressed={show === f.value} onClick={() => setShow(f.value)}>
              {f.label} {counts[f.value]}
            </button>
          ))}
        </div>
      </div>

      {tagCounts.length > 0 && (
        <div className="tag-filters" role="group" aria-label="Filtra per tag">
          {tagCounts.map(([t, n]) => (
            <button key={t} type="button" className={tag === t ? 'tag-filter active' : 'tag-filter'} aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}>
              {t} · {n}
            </button>
          ))}
        </div>
      )}

      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      {visible.length === 0 ? (
        <div className="empty">{mods.length === 0 ? 'Nessuna mod installata.' : 'Nessuna mod corrisponde ai filtri.'}</div>
      ) : (
        <div className="mod-grid">
          {visible.map((mod) => (
            <ModCard
              key={mod.name}
              mod={mod}
              serverId={serverId}
              tags={categoriesOf.get(mod.name) ?? []}
              update={updateOf.get(mod.name)}
              canDownload={Boolean(updates?.steamcmd)}
              busy={busy}
              updating={updating}
              jobItem={activeJobItem(job, (i) => i.name === mod.name)}
              cancelling={cancelling}
              onCancel={() => onCancel(mod.name)}
              nameOf={nameOf}
              onDetails={() => setDetails(mod.name)}
              onToggle={() => onToggle(mod)}
              onUpdate={() => onUpdate(mod.name)}
              onDelete={() => setPending({ kind: 'delete', mod, dependents: null })}
            />
          ))}
        </div>
      )}

      <Sheet
        open={pending !== null}
        title={pending?.kind === 'disable' ? 'Disabilitare anche le mod dipendenti?' : 'Eliminare la mod?'}
        onClose={() => setPending(null)}
      >
        {pending && (
          <div className="stack">
            {pending.kind === 'disable' ? (
              <p>
                Queste mod abilitate dipendono da <strong>{titleOf(pending.mod)}</strong>: {list(pending.dependents)}. Disabilitare anche loro?
              </p>
            ) : (
              <p>
                <strong>{titleOf(pending.mod)}</strong> verrà spostata nel cestino.
                {pending.dependents?.length ? ` Verranno disabilitate anche: ${list(pending.dependents)}.` : ''}
              </p>
            )}
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => (pending.kind === 'disable' ? onToggle(pending.mod, true) : onDelete(pending.mod, pending.dependents !== null))}
              >
                {pending.kind === 'disable' ? 'Disabilita tutte' : 'Elimina'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setPending(null)}>
                Annulla
              </button>
            </div>
          </div>
        )}
      </Sheet>

      <Sheet open={detailsMod !== undefined} title={detailsMod ? titleOf(detailsMod) : ''} wide onClose={() => setDetails(null)}>
        {detailsMod && (
          <ModDetails
            mod={detailsMod}
            serverId={serverId}
            tags={categoriesOf.get(detailsMod.name) ?? []}
            update={updateOf.get(detailsMod.name)}
            canSearch={Boolean(updates?.apiKey)}
            nameOf={nameOf}
          />
        )}
      </Sheet>
    </div>
  )
}

function ModCard(props: {
  mod: Mod
  serverId: string
  tags: string[]
  update: ModUpdate | undefined
  canDownload: boolean
  busy: boolean
  updating: boolean
  jobItem: UpdateJobItem | undefined
  cancelling: boolean
  onCancel: () => void
  nameOf: (name: string) => string
  onDetails: () => void
  onToggle: () => void
  onUpdate: () => void
  onDelete: () => void
}) {
  const { mod, update, tags } = props
  const hasUpdate = isUpdatable(update)
  const title = titleOf(mod)

  return (
    <article className={mod.enabled ? 'mod-card' : 'mod-card mod-card-off'}>
      <div className="mod-card-head">
        <button type="button" className="mod-icon-button dim" onClick={props.onDetails} aria-label={`Dettagli di ${title}`}>
          <ModIcon serverId={props.serverId} mod={mod} />
        </button>
        <div className="mod-card-heading">
          <h3 className="mod-title dim">
            <button type="button" className="link-button" onClick={props.onDetails}>
              {title}
            </button>
          </h3>
          {mod.author && <div className="mod-author">di {mod.author}</div>}
          <div className="pill-row">
            <span className={mod.enabled ? 'pill pill-on' : 'pill pill-off'}>{mod.enabled ? 'Abilitata' : 'Disabilitata'}</span>
            {hasUpdate ? (
              <span className="pill pill-update" title={update?.status === 'maybe' ? "Aggiornata nel Workshop dopo l'installazione" : undefined}>
                {mod.version ? `v${mod.version} → ` : ''}
                {update?.latestVersion ? `v${update.latestVersion}` : 'aggiornamento'}
              </span>
            ) : (
              mod.version && <span className="pill pill-plain">v{mod.version}</span>
            )}
            {update?.status === 'incompatible' && (
              <span className="pill pill-warning" title="Nel Workshop non c'è una versione per la tModLoader di questo server">
                incompatibile
              </span>
            )}
            {update?.status === 'unavailable' && (
              <span className="pill pill-plain" title="L'elemento del Workshop è stato rimosso o reso privato">
                non più nel Workshop
              </span>
            )}
          </div>
        </div>
      </div>

      {mod.error && <p className="error-text">{mod.error}</p>}
      {mod.description && <p className="mod-description-short dim">{mod.description}</p>}

      <div className="mod-tags dim">
        {tags.slice(0, 4).map((t) => (
          <span key={t} className="mod-tag">
            {t}
          </span>
        ))}
        {tags.length > 4 && (
          <span className="mod-tag" title={tags.slice(4).join(', ')}>
            +{tags.length - 4}
          </span>
        )}
      </div>

      {mod.missingDependencies.length > 0 && (
        <p className="error-text small">Dipendenze mancanti: {mod.missingDependencies.map(props.nameOf).join(', ')}</p>
      )}

      <div className="mod-meta">
        {mod.side ? SIDE_LABEL[mod.side] : 'Lato sconosciuto'} · {formatBytes(mod.size)}
      </div>

      {props.jobItem ? (
        <CardJobProgress item={props.jobItem} cancelling={props.cancelling} onCancel={props.onCancel} />
      ) : (
        <OverflowActions actions={modActions(props, title)} menuLabel={`Altre azioni per ${title}`} />
      )}
    </article>
  )
}

const downloadIcon = (
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

/** Azioni in fondo alla card, dalla più importante: se la card è stretta le ultime vanno nel menu «⋯». */
function modActions(
  props: { mod: Mod; serverId: string; update: ModUpdate | undefined; canDownload: boolean; busy: boolean; updating: boolean; onToggle: () => void; onUpdate: () => void; onDelete: () => void },
  title: string,
): OverflowAction[] {
  const { mod } = props
  const url = modDownloadUrl(props.serverId, mod.name)
  const toggleLabel = mod.enabled ? 'Disabilita' : 'Abilita'
  const toggleDisabled = props.busy || mod.error !== null
  const download = () => {
    const a = document.createElement('a')
    a.href = url
    a.download = ''
    a.click()
  }
  return [
    {
      key: 'toggle',
      priority: 4,
      label: toggleLabel,
      disabled: toggleDisabled,
      onSelect: props.onToggle,
      inline: (
        <button type="button" className={mod.enabled ? 'btn btn-sm btn-toggle-on' : 'btn btn-sm'} disabled={toggleDisabled} onClick={props.onToggle}>
          {toggleLabel}
        </button>
      ),
    },
    ...(isUpdatable(props.update) && props.canDownload
      ? [
          {
            key: 'update',
            priority: 3,
            label: 'Aggiorna',
            disabled: props.updating,
            onSelect: props.onUpdate,
            inline: (
              <button type="button" className="btn btn-sm btn-primary" disabled={props.updating} onClick={props.onUpdate}>
                Aggiorna
              </button>
            ),
          },
        ]
      : []),
    {
      key: 'download',
      priority: 1,
      end: true,
      label: 'Scarica il .tmod',
      icon: downloadIcon,
      onSelect: download,
      inline: (
        <a className="btn btn-sm btn-icon" href={url} download aria-label={`Scarica ${title}`} title="Scarica">
          {downloadIcon}
        </a>
      ),
    },
    {
      key: 'delete',
      priority: 2,
      end: true,
      danger: true,
      label: 'Elimina',
      icon: deleteIcon,
      disabled: props.busy,
      onSelect: props.onDelete,
      inline: (
        <button type="button" className="btn btn-sm btn-icon btn-danger-outline" disabled={props.busy} onClick={props.onDelete} aria-label={`Elimina ${title}`} title="Elimina">
          {deleteIcon}
        </button>
      ),
    },
  ]
}

function ModDetails(props: {
  mod: Mod
  serverId: string
  tags: string[]
  update: ModUpdate | undefined
  canSearch: boolean
  nameOf: (name: string) => string
}) {
  const { mod } = props
  return (
    <div className="stack">
      <div className="mod-details-head">
        <ModIcon serverId={props.serverId} mod={mod} />
        <div>
          {mod.displayName && <div className="mono small muted">{mod.name}</div>}
          {mod.author && <div>di {mod.author}</div>}
          {mod.version && <div className="muted small">Versione {mod.version}</div>}
        </div>
      </div>

      <dl className="details">
        {mod.addon ? (
          <>
            <dt>Aggiornamenti</dt>
            <dd>Si aggiorna insieme al pannello</dd>
          </>
        ) : (
          <>
            <dt>Workshop</dt>
            <dd>
              <WorkshopLinkEditor serverId={props.serverId} modName={mod.name} update={props.update} canSearch={props.canSearch} />
            </dd>
          </>
        )}
        {mod.workshop?.subscriptions != null && (
          <>
            <dt>Iscritti</dt>
            <dd>{mod.workshop.subscriptions.toLocaleString('it')}</dd>
          </>
        )}
        {props.tags.length > 0 && (
          <>
            <dt>Tag</dt>
            <dd className="mod-tags">
              {props.tags.map((t) => (
                <span key={t} className="mod-tag">
                  {t}
                </span>
              ))}
            </dd>
          </>
        )}
        <dt>Lato</dt>
        <dd>{mod.side ? SIDE_LABEL[mod.side] : '—'}</dd>
        <dt>Dipendenze</dt>
        <dd>
          {mod.dependencies.length === 0
            ? '—'
            : mod.dependencies.map((d) => (
                <span key={d} className={mod.missingDependencies.includes(d) ? 'tag tag-danger' : 'tag'} title={mod.missingDependencies.includes(d) ? 'Dipendenza mancante' : undefined}>
                  {props.nameOf(d)}
                </span>
              ))}
        </dd>
        {mod.optionalDependencies.length > 0 && (
          <>
            <dt>Dipendenze opzionali</dt>
            <dd>{mod.optionalDependencies.map(props.nameOf).join(', ')}</dd>
          </>
        )}
        <dt>Compilata per</dt>
        <dd>tModLoader {mod.tmlVersion ?? '—'}</dd>
        <dt>File</dt>
        <dd className="mono">
          {mod.file} · {formatBytes(mod.size)} · modificato {formatDate(mod.modifiedAt)}
        </dd>
        {mod.homepage && (
          <>
            <dt>Sito</dt>
            <dd>
              <a href={mod.homepage} target="_blank" rel="noreferrer noopener">
                {mod.homepage}
              </a>
            </dd>
          </>
        )}
      </dl>

      {mod.description && <p className="mod-description">{mod.description}</p>}

      <section className="stack-sm">
        <h3 className="section-title">Versioni</h3>
        <VersionArchive serverId={props.serverId} focus={mod.name} />
      </section>
    </div>
  )
}

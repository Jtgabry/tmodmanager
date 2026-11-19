import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import Sheet from '../../components/Sheet'
import OverflowActions, { type OverflowAction } from '../../components/OverflowActions'
import PageActions from '../../components/PageActions'
import { errorMessage } from '../../lib/api'
import { useCurrentServer } from '../../lib/currentServer'
import { formatBytes, formatDate } from '../../lib/format'
import { useModpacks, useMods, useSaveModpack, workshopCategories } from '../../lib/mods'
import type { BrowseItem, BrowseSort, Mod, UpdateJobItem } from '../../lib/types'
import { useCancelJobItem, useInstallFromWorkshop, usePendingMods, useUpdateJob, useWorkshopBrowse, useWorkshopItem } from '../../lib/workshop'
import CardJobProgress from './CardJobProgress'
import WorkshopQueue from './WorkshopQueue'

const SORTS: { value: BrowseSort; label: string }[] = [
  { value: 'popular', label: 'Più scaricate' },
  { value: 'trend', label: 'Di tendenza' },
  { value: 'recent', label: 'Nuove' },
  { value: 'updated', label: 'Aggiornate' },
]

/** Categorie del Workshop di tModLoader: valore usato da Steam → etichetta. */
const TAGS: { value: string; label: string }[] = [
  { value: 'new content', label: 'New Content' },
  { value: 'quality of life', label: 'Quality of Life' },
  { value: 'Utilities', label: 'Utilities' },
  { value: 'Gameplay Tweaks', label: 'Gameplay Tweaks' },
  { value: 'Visual Tweaks', label: 'Visual Tweaks' },
  { value: 'Audio Tweaks', label: 'Audio Tweaks' },
  { value: 'Custom World Gen', label: 'World Gen' },
  { value: 'library', label: 'Library' },
  { value: 'Translation', label: 'Translation' },
]

const ACTIVE: UpdateJobItem['state'][] = ['queued', 'downloading', 'installing']

/** Ritarda un valore che cambia a ogni tasto (la ricerca parte quando si smette di scrivere). */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return debounced
}

/** Stato di un elemento del Workshop rispetto al server: installato, in download, in attesa… */
type ItemStatus =
  | { kind: 'installable' }
  | { kind: 'incompatible'; requiresTml: string }
  | { kind: 'job'; item: UpdateJobItem }
  | { kind: 'failed'; message: string | null }
  | { kind: 'pending' }
  | { kind: 'installed'; mod: Mod }

/** Mod del Workshop: navigazione per categorie e ordinamenti, ricerca, installazione in coda. */
export default function WorkshopTab() {
  const server = useCurrentServer()
  const mods = useMods(server.id)
  const job = useUpdateJob(server.id)
  const pending = usePendingMods(server.id)
  const install = useInstallFromWorkshop(server.id)
  const queryClient = useQueryClient()
  const cancel = useCancelJobItem(server.id)
  // Arrivando da un modpack («Cerca nel Workshop»): le mod installate vengono aggiunte a quel pack
  const [params] = useSearchParams()
  const packs = useModpacks(server.id)
  const savePack = useSaveModpack(server.id)
  const targetPack = packs.data?.find((p) => p.id === params.get('pack'))
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<BrowseSort>('popular')
  const [tag, setTag] = useState<string | null>(null)
  const [details, setDetails] = useState<string | null>(null)
  const q = useDebounced(search.trim(), 400)
  // Cercando, l'ordine predefinito è per pertinenza
  const effectiveSort: BrowseSort = q && sort === 'popular' ? 'relevance' : sort
  const browse = useWorkshopBrowse(server.id, { q: q.length >= 2 ? q : '', sort: effectiveSort, tag })

  const items = useMemo(() => {
    // Steam a volte ripete un elemento tra una pagina e l'altra
    const seen = new Set<string>()
    return (browse.data?.pages ?? []).flatMap((p) => p.items).filter((i) => !seen.has(i.id) && seen.add(i.id))
  }, [browse.data])
  const total = browse.data?.pages[0]?.total ?? 0
  const tmlVersion = browse.data?.pages[0]?.tmlVersion ?? server.tmlVersion

  const statusOf = useMemo(() => {
    const byName = new Map((mods.data?.mods ?? []).map((m) => [m.name, m]))
    const waiting = new Set((pending.data ?? []).map((p) => p.name))
    const running = job.data?.state === 'running'
    const jobItems = new Map((job.data?.items ?? []).map((i) => [i.workshopId, i]))
    return (item: BrowseItem): ItemStatus => {
      const inJob = jobItems.get(item.id)
      if (inJob && running && ACTIVE.includes(inJob.state)) return { kind: 'job', item: inJob }
      const mod = item.modName ? byName.get(item.modName) : undefined
      if (mod) return waiting.has(mod.name) ? { kind: 'pending' } : { kind: 'installed', mod }
      // Installata da poco: l'elenco delle mod si ricarica a fine lavoro
      if (inJob?.install && inJob.state === 'done') return { kind: 'pending' }
      if (inJob?.state === 'error') return { kind: 'failed', message: inJob.message }
      if (!item.compatibleVersion && item.requiresTml) return { kind: 'incompatible', requiresTml: item.requiresTml }
      return { kind: 'installable' }
    }
  }, [mods.data, pending.data, job.data])

  const addToPack = (modName: string | null) => {
    if (!targetPack || !modName || targetPack.mods.includes(modName)) return
    savePack.mutate({ ...targetPack, mods: [...targetPack.mods, modName] })
  }
  const onInstall = (id: string) => {
    const item = items.find((i) => i.id === id)
    install.mutate([id], {
      onSuccess: () => {
        addToPack(item?.modName ?? null)
        // Un add-on di tModManager è installato subito (niente download da seguire): si ricaricano le mod
        if (item?.addon) {
          void queryClient.invalidateQueries({ queryKey: ['servers', server.id, 'mods'], exact: true })
          void queryClient.invalidateQueries({ queryKey: ['servers', server.id, 'workshop', 'pending'] })
          void queryClient.invalidateQueries({ queryKey: ['servers', server.id], exact: true })
        }
      },
    })
  }
  const packAction = (item: BrowseItem) =>
    targetPack && item.modName && (statusOf(item).kind === 'installed' || statusOf(item).kind === 'pending')
      ? { inPack: targetPack.mods.includes(item.modName), onAdd: () => addToPack(item.modName) }
      : undefined
  const detailsItem = details ? items.find((i) => i.id === details) : undefined

  return (
    <div className="stack">
      <PageActions>
        {browse.data && (
          <span className="muted page-summary">
            {total.toLocaleString('it')} mod{tmlVersion ? ` · tModLoader del server ${tmlVersion}` : ''}
          </span>
        )}
      </PageActions>

      {targetPack && (
        <div className="alert alert-success pack-alert">
          <span>
            Le mod che installi vengono aggiunte al modpack <strong>{targetPack.name}</strong>.
          </span>
          <Link className="btn btn-sm" to={`../modpacks/${targetPack.id}?tab=add`} relative="path">
            Torna al modpack
          </Link>
        </div>
      )}
      {savePack.error ? <div className="alert alert-error">{errorMessage(savePack.error)}</div> : null}

      <WorkshopQueue server={server} />

      <div className="mods-toolbar">
        <label className="search-box">
          <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            type="search"
            placeholder="Cerca nel Workshop di tModLoader…"
            aria-label="Cerca nel Workshop"
            value={search}
            maxLength={100}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="segmented" role="group" aria-label="Ordinamento">
          {SORTS.map((s) => (
            <button key={s.value} type="button" className={sort === s.value ? 'active' : ''} aria-pressed={sort === s.value} onClick={() => setSort(s.value)}>
              {s.value === 'popular' && q ? 'Pertinenza' : s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="tag-filters" role="group" aria-label="Categoria">
        {TAGS.map((t) => (
          <button key={t.value} type="button" className={tag === t.value ? 'tag-filter active' : 'tag-filter'} aria-pressed={tag === t.value} onClick={() => setTag(tag === t.value ? null : t.value)}>
            {t.label}
          </button>
        ))}
      </div>

      {install.error ? <div className="alert alert-error">{errorMessage(install.error)}</div> : null}
      {cancel.error ? <div className="alert alert-error">{errorMessage(cancel.error)}</div> : null}
      {browse.error && <div className="alert alert-error">{errorMessage(browse.error)}</div>}
      {browse.data?.pages[0]?.steamError && <div className="alert alert-info">{browse.data.pages[0].steamError}</div>}
      {browse.isLoading && <div className="spinner" />}

      {browse.data && items.length === 0 && <div className="empty">Nessuna mod trovata.</div>}

      {items.length > 0 && (
        <div className="mod-grid">
          {items.map((item) => (
            <WorkshopCard
              key={item.id}
              item={item}
              status={statusOf(item)}
              installing={install.isPending && install.variables?.[0] === item.id}
              onDetails={() => setDetails(item.id)}
              onInstall={() => onInstall(item.id)}
              cancelling={cancel.isPending}
              onCancel={(name) => cancel.mutate(name)}
              packAction={packAction(item)}
              packBusy={savePack.isPending}
            />
          ))}
        </div>
      )}

      {browse.hasNextPage && (
        <div className="load-more">
          <button type="button" className="btn" disabled={browse.isFetchingNextPage} onClick={() => void browse.fetchNextPage()}>
            {browse.isFetchingNextPage ? 'Caricamento…' : 'Carica altre'}
          </button>
        </div>
      )}

      <Sheet open={detailsItem !== undefined} title={detailsItem?.title ?? ''} wide onClose={() => setDetails(null)}>
        {detailsItem && (
          <WorkshopDetails
            serverId={server.id}
            item={detailsItem}
            status={statusOf(detailsItem)}
            installedNames={new Set((mods.data?.mods ?? []).map((m) => m.name))}
            installing={install.isPending}
            onInstall={() => onInstall(detailsItem.id)}
          />
        )}
      </Sheet>
    </div>
  )
}

function Thumb({ item, size = 80 }: { item: BrowseItem; size?: number }) {
  const [failed, setFailed] = useState(false)
  if (!item.previewUrl || failed) {
    return (
      <span className="mod-icon mod-icon-fallback workshop-thumb" style={{ width: size, height: size }} aria-hidden="true">
        {(item.title ?? '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?'}
      </span>
    )
  }
  return (
    <img
      className="mod-icon workshop-thumb"
      src={item.previewUrl}
      alt=""
      loading="lazy"
      width={size}
      height={size}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}

function StatusPills({ item, status }: { item: BrowseItem; status: ItemStatus }) {
  return (
    <div className="pill-row">
      {status.kind === 'installed' && <span className="pill pill-on">Installata{status.mod.version ? ` v${status.mod.version}` : ''}</span>}
      {status.kind === 'pending' && <span className="pill pill-update">Da abilitare</span>}
      {status.kind === 'incompatible' && (
        <span className="pill pill-warning" title="Nel Workshop non c'è una versione per la tModLoader di questo server">
          Richiede tModLoader {status.requiresTml}
        </span>
      )}
      {status.kind !== 'installed' && status.kind !== 'incompatible' && item.compatibleVersion && (
        <span className="pill pill-plain">v{item.compatibleVersion}</span>
      )}
    </div>
  )
}

/** Pulsante principale di una mod: Installa, oppure lo stato del download o dell'installazione. */
function InstallButton({ status, installing, onInstall }: { status: ItemStatus; installing: boolean; onInstall: () => void }) {
  if (status.kind === 'installed' || status.kind === 'pending') return null
  if (status.kind === 'job') {
    const { item } = status
    const text =
      item.state === 'queued'
        ? 'In coda'
        : item.state === 'installing'
          ? 'Installazione…'
          : item.bytes != null && item.totalBytes
            ? `Download ${Math.min(99, Math.round((item.bytes / item.totalBytes) * 100))}%`
            : 'Download…'
    return (
      <button type="button" className="btn btn-sm" disabled>
        {text}
      </button>
    )
  }
  if (status.kind === 'incompatible') {
    return (
      <button type="button" className="btn btn-sm" disabled title="Aggiorna tModLoader per poterla installare">
        Incompatibile
      </button>
    )
  }
  return (
    <button type="button" className="btn btn-sm btn-primary" disabled={installing} onClick={onInstall}>
      {installing ? 'Avvio…' : status.kind === 'failed' ? 'Riprova' : 'Installa'}
    </button>
  )
}

const steamIcon = (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M14 4h6v6" />
    <path d="M20 4l-9 9" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </svg>
)

/** Azioni in fondo alla card, dalla più importante: se la card è stretta le ultime vanno nel menu «⋯». */
function workshopActions(
  props: { item: BrowseItem; status: ItemStatus; installing: boolean; onInstall: () => void; packAction?: { inPack: boolean; onAdd: () => void }; packBusy?: boolean },
  title: string,
): OverflowAction[] {
  const { item, status } = props
  const actions: OverflowAction[] = []
  if (status.kind === 'incompatible') {
    actions.push({
      key: 'install',
      priority: 4,
      label: 'Incompatibile',
      disabled: true,
      onSelect: () => undefined,
      inline: <InstallButton status={status} installing={props.installing} onInstall={props.onInstall} />,
    })
  } else if (status.kind === 'installable' || status.kind === 'failed') {
    const label = props.installing ? 'Avvio…' : status.kind === 'failed' ? 'Riprova' : 'Installa'
    actions.push({
      key: 'install',
      priority: 4,
      label,
      disabled: props.installing,
      onSelect: props.onInstall,
      inline: <InstallButton status={status} installing={props.installing} onInstall={props.onInstall} />,
    })
  }
  if (props.packAction) {
    const { inPack, onAdd } = props.packAction
    actions.push({
      key: 'pack',
      priority: 3,
      label: inPack ? 'Già nel pack' : 'Aggiungi al pack',
      disabled: inPack || props.packBusy,
      onSelect: onAdd,
      inline: inPack ? (
        <span className="pill pill-on">Nel pack</span>
      ) : (
        <button type="button" className="btn btn-sm" disabled={props.packBusy} onClick={onAdd}>
          Aggiungi al pack
        </button>
      ),
    })
  }
  if (item.addon) return actions // add-on di tModManager: non è su Steam
  actions.push({
    key: 'steam',
    priority: 1,
    end: true,
    label: 'Apri su Steam',
    icon: steamIcon,
    onSelect: () => window.open(item.url, '_blank', 'noopener,noreferrer'),
    inline: (
      <a className="btn btn-sm btn-icon" href={item.url} target="_blank" rel="noreferrer noopener" aria-label={`${title} su Steam`} title="Apri su Steam">
        {steamIcon}
      </a>
    ),
  })
  return actions
}

function WorkshopCard(props: {
  item: BrowseItem
  status: ItemStatus
  installing: boolean
  onDetails: () => void
  onInstall: () => void
  cancelling: boolean
  onCancel: (name: string) => void
  /** Pagina aperta da un modpack: per le mod già installate, «Aggiungi al pack». */
  packAction?: { inPack: boolean; onAdd: () => void }
  packBusy?: boolean
}) {
  const { item, status } = props
  const tags = workshopCategories(item.tags)
  const title = item.title ?? item.id
  return (
    <article className="mod-card">
      <div className="mod-card-head">
        <button type="button" className="mod-icon-button" onClick={props.onDetails} aria-label={`Dettagli di ${title}`}>
          <Thumb item={item} />
        </button>
        <div className="mod-card-heading">
          <h3 className="mod-title">
            <button type="button" className="link-button" onClick={props.onDetails}>
              {title}
            </button>
          </h3>
          {item.addon ? (
            <div className="mod-author">di tModManager</div>
          ) : (
            item.subscriptions != null && <div className="mod-author">{item.subscriptions.toLocaleString('it')} iscritti</div>
          )}
          <StatusPills item={item} status={status} />
        </div>
      </div>

      {item.description && <p className="mod-description-short">{item.description}</p>}

      <div className="mod-tags">
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

      {status.kind === 'failed' && status.message && <p className="error-text small">{status.message}</p>}

      <div className="mod-meta">
        {item.fileSize != null ? formatBytes(item.fileSize) : '—'}
        {item.timeUpdated ? ` · aggiornata ${formatDate(item.timeUpdated)}` : ''}
      </div>

      {status.kind === 'job' ? (
        <CardJobProgress item={status.item} cancelling={props.cancelling} onCancel={() => props.onCancel(status.item.name)} />
      ) : (
        <OverflowActions actions={workshopActions(props, title)} menuLabel={`Altre azioni per ${title}`} />
      )}
    </article>
  )
}

function WorkshopDetails(props: {
  serverId: string
  item: BrowseItem
  status: ItemStatus
  installedNames: Set<string>
  installing: boolean
  onInstall: () => void
}) {
  const { item, status } = props
  const full = useWorkshopItem(props.serverId, item.id)
  const data = full.data ?? item
  const tags = workshopCategories(item.tags)
  const deps = full.data?.dependencyItems ?? []

  return (
    <div className="stack">
      <div className="mod-details-head">
        <Thumb item={item} size={120} />
        <div className="workshop-details-side">
          {item.modName && <div className="mono small muted">{item.modName}</div>}
          <StatusPills item={item} status={status} />
          <div className="btn-row">
            <InstallButton status={status} installing={props.installing} onInstall={props.onInstall} />
            {!item.addon && (
              <a className="btn btn-sm" href={item.url} target="_blank" rel="noreferrer noopener">
                Apri su Steam
              </a>
            )}
          </div>
        </div>
      </div>

      {status.kind === 'failed' && status.message && <div className="alert alert-error">{status.message}</div>}

      <dl className="details">
        {item.subscriptions != null && (
          <>
            <dt>Iscritti</dt>
            <dd>{item.subscriptions.toLocaleString('it')}</dd>
          </>
        )}
        {tags.length > 0 && (
          <>
            <dt>Tag</dt>
            <dd className="mod-tags">
              {tags.map((t) => (
                <span key={t} className="mod-tag">
                  {t}
                </span>
              ))}
            </dd>
          </>
        )}
        <dt>Versione per il server</dt>
        <dd>
          {item.compatibleVersion
            ? `v${item.compatibleVersion}`
            : item.requiresTml
              ? `nessuna: serve tModLoader ${item.requiresTml} o successiva`
              : 'non dichiarata'}
        </dd>
        <dt>Dipendenze</dt>
        <dd>
          {item.dependencies.length === 0
            ? '—'
            : full.isLoading
              ? 'caricamento…'
              : deps.map((d) => {
                  const present = d.modName !== null && props.installedNames.has(d.modName)
                  return (
                    <span key={d.id} className={present ? 'tag tag-used' : 'tag'} title={present ? 'Già installata' : 'Verrà scaricata insieme alla mod, se richiesta'}>
                      {d.title ?? d.id}
                    </span>
                  )
                })}
        </dd>
        <dt>Dimensione</dt>
        <dd>{formatBytes(item.fileSize)}</dd>
        <dt>Aggiornata</dt>
        <dd>
          {formatDate(item.timeUpdated)}
          {item.timeCreated ? ` · pubblicata ${formatDate(item.timeCreated)}` : ''}
        </dd>
        {item.addon && (
          <>
            <dt>Autore</dt>
            <dd>tModManager · si aggiorna insieme al pannello</dd>
          </>
        )}
      </dl>

      {full.error ? <div className="alert alert-error">{errorMessage(full.error)}</div> : null}
      {full.isLoading && <p className="muted small">Caricamento della descrizione…</p>}
      {data.description && <p className="mod-description workshop-description">{data.description}</p>}

      {(full.data?.images.length ?? 0) > 0 && (
        <div className="workshop-images">
          {full.data!.images.slice(0, 8).map((src) => (
            <a key={src} href={src} target="_blank" rel="noreferrer noopener">
              <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" />
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

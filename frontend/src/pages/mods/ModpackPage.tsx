import { type ReactNode, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import Sheet from '../../components/Sheet'
import OverflowActions, { type OverflowAction } from '../../components/OverflowActions'
import { errorMessage } from '../../lib/api'
import { useCurrentServer } from '../../lib/currentServer'
import { formatBytes, formatDate } from '../../lib/format'
import { activeJobItem } from '../../lib/jobs'
import { dependencyClosure, freeName, PACK_STATE, packModsOf, packSize } from '../../lib/modpacks'
import { useArchive, useDeleteModpack, useModpacks, useMods, useSaveModpack } from '../../lib/mods'
import type { ArchiveEntry, Mod, Modpack } from '../../lib/types'
import { useCancelJobItem, useInstallByName, useUpdateJob } from '../../lib/workshop'
import CardJobProgress from './CardJobProgress'
import ExportPackSheet from './ExportPackSheet'
import ModIcon, { ModInitials } from './ModIcon'
import PackCover from './PackCover'
import { usePackActivation } from './usePackActivation'
import VersionArchive from './VersionArchive'

type PackFilter = 'all' | 'pinned' | 'fix'

/** Pagina di un modpack: intestazione (copertina, nome, descrizione, attivazione) e due tab. */
export default function ModpackPage() {
  const server = useCurrentServer()
  const { packId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const mods = useMods(server.id)
  const packs = useModpacks(server.id)
  const archive = useArchive(server.id)
  const save = useSaveModpack(server.id)
  const [versionsOf, setVersionsOf] = useState<string | null>(null)

  const byName = useMemo(() => new Map((mods.data?.mods ?? []).map((m) => [m.name, m])), [mods.data])
  const archiveOf = useMemo(() => new Map((archive.data ?? []).map((e) => [e.name, e])), [archive.data])

  if (mods.isLoading || packs.isLoading) return <div className="spinner" />
  if (mods.error || packs.error) return <div className="alert alert-error">{errorMessage(mods.error ?? packs.error)}</div>

  const pack = packs.data?.find((p) => p.id === packId)
  if (!pack) {
    return (
      <div className="stack">
        <BackLink />
        <div className="empty">Modpack non trovato: forse è stato eliminato.</div>
      </div>
    )
  }

  const tab = params.get('tab') === 'add' ? 'add' : 'mods'
  const nameOf = (name: string) => byName.get(name)?.displayName ?? archiveOf.get(name)?.displayName ?? name

  /** Salva il pack con le modifiche indicate. */
  const update = (changes: Partial<Pick<Modpack, 'name' | 'description' | 'mods' | 'versions'>>, onSuccess?: () => void) =>
    save.mutate(
      { id: pack.id, name: pack.name, description: pack.description, mods: pack.mods, versions: pack.versions, ...changes },
      { onSuccess },
    )

  return (
    <div className="stack">
      <BackLink />
      <PackHero
        key={pack.id}
        serverId={server.id}
        pack={pack}
        packs={packs.data ?? []}
        byName={byName}
        nameOf={nameOf}
        onSave={update}
        saving={save.isPending}
        onDeleted={() => navigate('..', { relative: 'path' })}
        onDuplicated={(id) => navigate(`../${id}`, { relative: 'path' })}
      />
      {save.error ? <div className="alert alert-error">{errorMessage(save.error)}</div> : null}

      <nav className="tabs pack-tabs" aria-label="Sezioni del modpack">
        <Link to="?" replace className={tab === 'mods' ? 'active' : ''} aria-current={tab === 'mods' ? 'page' : undefined}>
          Nel pack <span className="count-badge">{pack.mods.length}</span>
        </Link>
        <Link to="?tab=add" replace className={tab === 'add' ? 'active' : ''} aria-current={tab === 'add' ? 'page' : undefined}>
          Aggiungi mod
        </Link>
      </nav>

      {tab === 'mods' ? (
        <PackModsTab
          serverId={server.id}
          pack={pack}
          byName={byName}
          archiveOf={archiveOf}
          nameOf={nameOf}
          saving={save.isPending}
          onSave={update}
          onAdd={() => setParams({ tab: 'add' }, { replace: true })}
          onVersions={setVersionsOf}
        />
      ) : (
        <AddModsTab
          serverId={server.id}
          pack={pack}
          packs={packs.data ?? []}
          byName={byName}
          archiveOf={archiveOf}
          nameOf={nameOf}
          saving={save.isPending}
          onSave={update}
        />
      )}

      <Sheet open={versionsOf !== null} title={versionsOf ? `Versioni di ${nameOf(versionsOf)}` : ''} wide onClose={() => setVersionsOf(null)}>
        {versionsOf && <VersionArchive serverId={server.id} focus={versionsOf} />}
      </Sheet>
    </div>
  )
}

function BackLink() {
  return (
    <Link to=".." relative="path" className="back-link">
      <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M15 18l-6-6 6-6" />
      </svg>
      Modpack
    </Link>
  )
}

// --- Intestazione --------------------------------------------------------------------------------

function PackHero(props: {
  serverId: string
  pack: Modpack
  packs: Modpack[]
  byName: Map<string, Mod>
  nameOf: (name: string) => string
  onSave: (changes: Partial<Pick<Modpack, 'name' | 'description'>>, onSuccess?: () => void) => void
  saving: boolean
  onDeleted: () => void
  onDuplicated: (id: string) => void
}) {
  const { pack, byName } = props
  const duplicate = useSaveModpack(props.serverId)
  const remove = useDeleteModpack(props.serverId)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(pack.name)
  // Testo in modifica (null = si mostra quello salvato)
  const [draft, setDraft] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [activationError, setActivationError] = useState<string | null>(null)

  const state = PACK_STATE[pack.state]
  const missing = pack.missing.length
  const blocked = missing > 0 || pack.unavailable.length > 0 || pack.mods.length === 0

  const saveName = () => {
    const trimmed = name.trim()
    if (trimmed && trimmed !== pack.name) props.onSave({ name: trimmed }, () => setRenaming(false))
    else {
      setName(pack.name)
      setRenaming(false)
    }
  }

  const onDuplicate = () =>
    duplicate.mutate(
      { name: freeName(`${pack.name} (copia)`, props.packs), description: pack.description, mods: pack.mods, versions: pack.versions },
      { onSuccess: (copy) => props.onDuplicated(copy.id) },
    )

  const activation = usePackActivation({
    serverId: props.serverId,
    pack,
    packs: props.packs,
    byName,
    blocked,
    onResult: (n, e) => {
      setNotice(n)
      setActivationError(e)
    },
  })
  const toggleLabel = activation.busy ? 'Un momento…' : pack.active ? 'Disattiva il modpack' : 'Attiva il modpack'
  const toggleDisabled = activation.busy || (!pack.active && blocked)
  const exclusiveDisabled = activation.busy || blocked
  const duplicateIcon = (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  )
  const exportIcon = (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4v11" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 20h14" />
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

  // Attivazione a sinistra, il resto a destra: se la riga è stretta, Duplica ed Esporta passano insieme nel menu «⋯» (poi Elimina)
  const actions: OverflowAction[] = [
    {
      key: 'toggle',
      priority: 10,
      label: toggleLabel,
      disabled: toggleDisabled,
      onSelect: activation.toggle,
      inline: (
        <button
          type="button"
          className={pack.active ? 'btn btn-sm btn-toggle-on' : 'btn btn-sm btn-primary'}
          disabled={toggleDisabled}
          title={pack.active ? undefined : 'Abilita le mod del pack; le altre mod restano come sono'}
          onClick={activation.toggle}
        >
          {toggleLabel}
        </button>
      ),
    },
    ...(!pack.active
      ? [
          {
            key: 'exclusive',
            priority: 9,
            label: 'Attiva solo questo',
            disabled: exclusiveDisabled,
            onSelect: activation.exclusive,
            inline: (
              <button
                type="button"
                className="btn btn-sm"
                disabled={exclusiveDisabled}
                title="Abilita solo le mod di questo pack e disabilita tutte le altre"
                onClick={activation.exclusive}
              >
                Attiva solo questo
              </button>
            ),
          },
        ]
      : []),
    {
      key: 'duplicate',
      priority: 1,
      end: true,
      group: 'copy',
      label: 'Duplica',
      icon: duplicateIcon,
      disabled: duplicate.isPending,
      onSelect: onDuplicate,
      inline: (
        <button type="button" className="btn btn-sm" disabled={duplicate.isPending} onClick={onDuplicate}>
          Duplica
        </button>
      ),
    },
    {
      key: 'export',
      priority: 1,
      end: true,
      group: 'copy',
      label: 'Esporta',
      icon: exportIcon,
      disabled: pack.mods.length === 0,
      onSelect: () => setExporting(true),
      inline: (
        <button type="button" className="btn btn-sm" disabled={pack.mods.length === 0} title="Cartella del modpack (.zip) o elenco delle mod (.json)" onClick={() => setExporting(true)}>
          Esporta
        </button>
      ),
    },
    {
      key: 'delete',
      priority: 3,
      end: true,
      afterMenu: true,
      danger: true,
      label: 'Elimina',
      icon: deleteIcon,
      onSelect: () => setConfirmDelete(true),
      inline: (
        <button type="button" className="btn btn-sm btn-icon btn-danger-outline" aria-label="Elimina il modpack" title="Elimina" onClick={() => setConfirmDelete(true)}>
          {deleteIcon}
        </button>
      ),
    },
  ]

  return (
    <section className="pack-hero">
      <PackCover serverId={props.serverId} packMods={packModsOf(pack, byName)} size={132} />

      <div className="pack-hero-main">
        <div className="pack-hero-title">
          {renaming ? (
            <form
              className="pack-rename"
              onSubmit={(e) => {
                e.preventDefault()
                saveName()
              }}
            >
              <input autoFocus required maxLength={64} aria-label="Nome del modpack" value={name} onChange={(e) => setName(e.target.value)} onBlur={saveName} />
            </form>
          ) : (
            <>
              <h2>{pack.name}</h2>
              <button
                type="button"
                className="icon-btn"
                aria-label="Rinomina"
                title="Rinomina"
                onClick={() => {
                  setName(pack.name)
                  setRenaming(true)
                }}
              >
                <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 20h4L19 9l-4-4L4 16z" />
                </svg>
              </button>
            </>
          )}
          <span className={state.className}>{state.text}</span>
        </div>

        <label className="field">
          <span>Descrizione</span>
          <textarea
            rows={2}
            maxLength={500}
            placeholder="A cosa serve questo modpack? (facoltativa)"
            value={draft ?? pack.description}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft === null || draft === pack.description) setDraft(null)
              else props.onSave({ description: draft }, () => setDraft(null))
            }}
          />
        </label>

        <div className="muted small">
          {pack.mods.length} mod
          {missing > 0 ? ` · ${missing} da installare` : ''} · {formatBytes(packSize(pack, byName))}
          {pack.createdAt ? ` · creato il ${formatDate(pack.createdAt)}` : ''}
          {props.saving ? ' · salvataggio…' : ''}
        </div>
      </div>

      {blocked && pack.mods.length > 0 && (
        <p className="muted small pack-hero-blocked">Per attivarlo, prima installa le mod mancanti (o scegli di nuovo le versioni non più disponibili).</p>
      )}

      <div className="pack-hero-bar">
        <OverflowActions actions={actions} menuLabel="Altre azioni per il modpack" />
        {activation.dialog}
      </div>
      <ExportPackSheet serverId={props.serverId} pack={exporting ? pack : null} onClose={() => setExporting(false)} />

      {(notice || activationError || duplicate.error) && (
        <div className="pack-hero-notice">
          {notice && <div className="alert alert-success">{notice}</div>}
          {activationError && <div className="alert alert-error">{activationError}</div>}
          {duplicate.error ? <div className="alert alert-error">{errorMessage(duplicate.error)}</div> : null}
        </div>
      )}

      <Sheet open={confirmDelete} title="Eliminare il modpack?" onClose={() => setConfirmDelete(false)}>
        <div className="stack">
          <p>
            <strong>{pack.name}</strong> verrà eliminato. Le mod restano installate così come sono.
          </p>
          {remove.error ? <div className="alert alert-error">{errorMessage(remove.error)}</div> : null}
          <div className="btn-row">
            <button type="button" className="btn btn-danger" disabled={remove.isPending} onClick={() => remove.mutate(pack.id, { onSuccess: props.onDeleted })}>
              Elimina
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>
              Annulla
            </button>
          </div>
        </div>
      </Sheet>
    </section>
  )
}

// --- Selettore di versione -------------------------------------------------------------------

/**
 * Versione nel pack: «segue gli aggiornamenti» (valore vuoto), quella installata o una dell'archivio.
 * Una versione bloccata non più disponibile resta in elenco, segnalata.
 */
function VersionSelect(props: {
  installed: string | null
  archived: ArchiveEntry | undefined
  value: string | null
  disabled?: boolean
  onChange: (version: string | null) => void
  label: string
}) {
  const archived = props.archived?.versions ?? []
  const known = new Set([props.installed, ...archived.map((v) => v.version)])
  const lost = props.value && !known.has(props.value) ? props.value : null
  return (
    <select
      className={props.value ? 'version-select version-select-pinned' : 'version-select'}
      aria-label={props.label}
      value={props.value ?? ''}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value || null)}
    >
      <option value="">Segue gli aggiornamenti{props.installed ? ` (ora v${props.installed})` : ''}</option>
      {props.installed && (
        <optgroup label="Sul server">
          <option value={props.installed}>v{props.installed} · installata</option>
        </optgroup>
      )}
      {archived.length > 0 && (
        <optgroup label="Archivio">
          {archived.map((v) => (
            <option key={v.version} value={v.version}>
              v{v.version} · tModLoader {v.tmlVersion}
            </option>
          ))}
        </optgroup>
      )}
      {lost && <option value={lost}>v{lost} · non più disponibile</option>}
    </select>
  )
}

// --- Tab «Nel pack» ----------------------------------------------------------------------------

function PackModsTab(props: {
  serverId: string
  pack: Modpack
  byName: Map<string, Mod>
  archiveOf: Map<string, ArchiveEntry>
  nameOf: (name: string) => string
  saving: boolean
  onSave: (changes: Partial<Pick<Modpack, 'mods' | 'versions'>>) => void
  onAdd: () => void
  onVersions: (name: string) => void
}) {
  const { pack, byName, archiveOf, nameOf } = props
  const job = useUpdateJob(props.serverId)
  const install = useInstallByName(props.serverId)
  const cancel = useCancelJobItem(props.serverId)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<PackFilter>('all')

  const inPack = useMemo(() => new Set(pack.mods), [pack.mods])
  /** Dipendenze delle mod del pack che non sono nel pack (l'attivazione le abilita comunque). */
  const depsOutside = useMemo(() => [...dependencyClosure(pack.mods, byName)].filter((d) => !inPack.has(d)), [pack.mods, byName, inPack])
  const notesOf = (name: string) => (byName.get(name)?.dependencies ?? []).filter((d) => !inPack.has(d))
  const needsFix = (name: string) => pack.missing.includes(name) || pack.unavailable.includes(name) || notesOf(name).length > 0
  const switching = new Map(pack.toSwitch.map((s) => [s.name, s]))

  const counts = { all: pack.mods.length, pinned: pack.mods.filter((m) => pack.versions[m]).length, fix: pack.mods.filter(needsFix).length }
  const visible = pack.mods.filter((name) => {
    if (filter === 'pinned' && !pack.versions[name]) return false
    if (filter === 'fix' && !needsFix(name)) return false
    const q = query.trim().toLowerCase()
    return !q || name.toLowerCase().includes(q) || nameOf(name).toLowerCase().includes(q)
  })

  const setVersion = (name: string, version: string | null) => {
    const versions = { ...pack.versions }
    if (version) versions[name] = version
    else delete versions[name]
    props.onSave({ versions })
  }
  const removeMod = (name: string) => {
    const versions = { ...pack.versions }
    delete versions[name]
    props.onSave({ mods: pack.mods.filter((m) => m !== name), versions })
  }
  const missingToInstall = pack.missing.filter((m) => !activeJobItem(job.data, (i) => i.name === m))

  if (pack.mods.length === 0) {
    return (
      <div className="empty pack-empty">
        <span>Il modpack è vuoto.</span>
        <span className="btn-row">
          <AddEnabledButton pack={pack} byName={byName} saving={props.saving} primary onAdd={(names) => props.onSave({ mods: [...pack.mods, ...names] })} />
          <button type="button" className="btn" onClick={props.onAdd}>
            Scegli le mod
          </button>
        </span>
      </div>
    )
  }

  return (
    <div className="stack">
      {(pack.missing.length > 0 || depsOutside.length > 0) && (
        <div className="alert alert-warning pack-alert">
          <span>
            {pack.missing.length > 0 && <>Non installate: {pack.missing.map(nameOf).join(', ')}. </>}
            {depsOutside.length > 0 && <>Dipendenze che non sono nel pack: {depsOutside.map(nameOf).join(', ')}.</>}
          </span>
          <span className="btn-row">
            {missingToInstall.length > 0 && (
              <button type="button" className="btn btn-sm" disabled={install.isPending} onClick={() => install.mutate(missingToInstall)}>
                Installa dal Workshop ({missingToInstall.length})
              </button>
            )}
            {depsOutside.length > 0 && (
              <button type="button" className="btn btn-sm" disabled={props.saving} onClick={() => props.onSave({ mods: [...pack.mods, ...depsOutside] })}>
                Aggiungi le dipendenze ({depsOutside.length})
              </button>
            )}
          </span>
        </div>
      )}
      {pack.unavailable.length > 0 && (
        <div className="alert alert-error">
          Versioni bloccate non più disponibili: {pack.unavailable.map((n) => `${nameOf(n)} v${pack.versions[n]}`).join(', ')}. Scegline un'altra.
        </div>
      )}
      {pack.toSwitch.length > 0 && (
        <p className="hint">
          Attivando il pack verranno installate dall'archivio:{' '}
          {pack.toSwitch.map((s) => `${nameOf(s.name)} v${s.to}${s.from ? ` (al posto della v${s.from})` : ''}`).join(', ')}.
        </p>
      )}
      {install.error ? <div className="alert alert-error">{errorMessage(install.error)}</div> : null}
      {cancel.error ? <div className="alert alert-error">{errorMessage(cancel.error)}</div> : null}

      <div className="mods-toolbar">
        <label className="search-box">
          <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input type="search" placeholder="Cerca nel modpack…" aria-label="Cerca nel modpack" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="segmented" role="group" aria-label="Filtro">
          {(
            [
              ['all', 'Tutte'],
              ['pinned', 'Versione bloccata'],
              ['fix', 'Da sistemare'],
            ] as const
          ).map(([value, label]) => (
            <button key={value} type="button" className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>
              {label} {counts[value]}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="empty">Nessuna mod corrisponde ai filtri.</div>
      ) : (
        <div className="mod-grid">
          {visible.map((name) => {
            const mod = byName.get(name)
            const missing = pack.missing.includes(name)
            const jobItem = activeJobItem(job.data, (i) => i.name === name)
            const deps = notesOf(name)
            const sw = switching.get(name)
            return (
              <PackModCard
                key={name}
                serverId={props.serverId}
                name={name}
                title={nameOf(name)}
                mod={mod}
                missing={missing}
                note={
                  pack.unavailable.includes(name)
                    ? `La v${pack.versions[name]} non è più disponibile: scegli un'altra versione.`
                    : deps.length
                      ? `Richiede ${deps.map(nameOf).join(', ')}, che non è nel pack.`
                      : null
                }
                pills={
                  <>
                    {missing ? (
                      <span className="pill pill-warning">Non installata</span>
                    ) : mod?.enabled ? (
                      <span className="pill pill-on">Abilitata sul server</span>
                    ) : (
                      <span className="pill pill-off">Disabilitata</span>
                    )}
                    {sw && sw.from && <span className="pill pill-plain" title="Versione installata ora">ora v{sw.from}</span>}
                  </>
                }
                version={
                  <div className="pack-version">
                    <span className="pack-version-label">Versione nel pack</span>
                    <VersionSelect
                      label={`Versione di ${nameOf(name)} nel pack`}
                      installed={mod?.version ?? null}
                      archived={archiveOf.get(name)}
                      value={pack.versions[name] ?? null}
                      disabled={props.saving}
                      onChange={(v) => setVersion(name, v)}
                    />
                    <button type="button" className="link-button small" onClick={() => props.onVersions(name)}>
                      Gestisci le versioni
                    </button>
                  </div>
                }
                actions={
                  jobItem ? (
                    <CardJobProgress item={jobItem} cancelling={cancel.isPending} onCancel={() => cancel.mutate(name)} />
                  ) : (
                    <div className="mod-card-actions">
                      {missing && (
                        <button type="button" className="btn btn-sm btn-primary" disabled={install.isPending} onClick={() => install.mutate([name])}>
                          Installa dal Workshop
                        </button>
                      )}
                      <span className="spacer" />
                      <button type="button" className="btn btn-sm btn-danger-outline" disabled={props.saving} onClick={() => removeMod(name)}>
                        Togli dal pack
                      </button>
                    </div>
                  )
                }
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Mod abilitate sul server che non sono ancora nel pack. */
const enabledOutside = (pack: Modpack, byName: Map<string, Mod>) =>
  [...byName.values()].filter((m) => m.enabled && !pack.mods.includes(m.name)).map((m) => m.name)

/** «Aggiungi le mod abilitate»: mette nel pack tutte le mod abilitate ora sul server (quelle che mancano). */
function AddEnabledButton(props: { pack: Modpack; byName: Map<string, Mod>; saving: boolean; onAdd: (names: string[]) => void; primary?: boolean }) {
  const names = enabledOutside(props.pack, props.byName)
  return (
    <button
      type="button"
      className={props.primary ? 'btn btn-primary' : 'btn'}
      disabled={props.saving || names.length === 0}
      title={names.length ? 'Aggiunge al pack tutte le mod abilitate ora sul server' : 'Tutte le mod abilitate sono già nel pack'}
      onClick={() => props.onAdd(names)}
    >
      <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 12l5 5 9-10" />
      </svg>
      Aggiungi le mod abilitate{names.length ? ` (${names.length})` : ''}
    </button>
  )
}

/** Card di una mod nelle due tab: stessa struttura delle card della pagina Mod. */
function PackModCard(props: {
  serverId: string
  name: string
  title: string
  mod: Mod | undefined
  missing?: boolean
  pills: ReactNode
  note?: string | null
  extra?: string | null
  version: ReactNode
  actions: ReactNode
  highlight?: boolean
}) {
  const { mod } = props
  return (
    <article className={`mod-card${props.missing ? ' pack-mod-missing' : ''}${props.highlight ? ' pack-mod-added' : ''}`}>
      <div className="mod-card-head">
        {mod ? <ModIcon serverId={props.serverId} mod={mod} /> : <ModInitials title={props.title} />}
        <div className="mod-card-heading">
          <h3 className="mod-title">
            <span className="mod-title-text">{props.title}</span>
          </h3>
          {mod?.author && <div className="mod-author">di {mod.author}</div>}
          <div className="pill-row">{props.pills}</div>
        </div>
      </div>
      {mod?.description ? (
        <p className="mod-description-short">{mod.description}</p>
      ) : (
        <p className="mod-description-short muted">{props.missing ? 'Non installata su questo server.' : ''}</p>
      )}
      {props.extra && <p className="muted small pack-mod-extra">{props.extra}</p>}
      {props.note && <p className="error-text small">{props.note}</p>}
      {props.version}
      {props.actions}
    </article>
  )
}

// --- Tab «Aggiungi mod» --------------------------------------------------------------------------

function AddModsTab(props: {
  serverId: string
  pack: Modpack
  packs: Modpack[]
  byName: Map<string, Mod>
  archiveOf: Map<string, ArchiveEntry>
  nameOf: (name: string) => string
  saving: boolean
  onSave: (changes: Partial<Pick<Modpack, 'mods' | 'versions'>>) => void
}) {
  const { pack, byName, archiveOf, nameOf } = props
  const job = useUpdateJob(props.serverId)
  const [query, setQuery] = useState('')
  const [withDeps, setWithDeps] = useState(true)
  const [chosen, setChosen] = useState<Record<string, string | null>>({})
  /** Aggiunte in questa visita: restano visibili con «Annulla» invece di sparire. */
  const [added, setAdded] = useState<Record<string, string[]>>({})

  const inPack = useMemo(() => new Set(pack.mods), [pack.mods])
  const candidates = useMemo(() => {
    // Installate, più quelle solo nell'archivio (non installate ma con versioni salvate)
    const names = new Set([...byName.keys(), ...archiveOf.keys()])
    const q = query.trim().toLowerCase()
    return [...names]
      .filter((n) => !inPack.has(n) || added[n])
      .filter((n) => !byName.get(n)?.error)
      .filter((n) => !q || n.toLowerCase().includes(q) || nameOf(n).toLowerCase().includes(q) || (byName.get(n)?.author ?? '').toLowerCase().includes(q))
      .sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'it', { sensitivity: 'base' }))
  }, [byName, archiveOf, query, inPack, added, nameOf])

  /** Ultima aggiunta in blocco delle mod abilitate (per poterla annullare). */
  const [bulk, setBulk] = useState<string[] | null>(null)
  const addEnabled = (names: string[]) => {
    props.onSave({ mods: [...pack.mods, ...names] })
    setBulk(names)
    setAdded((a) => ({ ...a, ...Object.fromEntries(names.map((n) => [n, [n]])) }))
  }
  const undoBulk = () => {
    if (!bulk) return
    const remove = new Set(bulk)
    const versions = Object.fromEntries(Object.entries(pack.versions).filter(([n]) => !remove.has(n)))
    props.onSave({ mods: pack.mods.filter((m) => !remove.has(m)), versions })
    setAdded((a) => Object.fromEntries(Object.entries(a).filter(([n]) => !remove.has(n))))
    setBulk(null)
  }

  const otherPacksOf = (name: string) => props.packs.filter((p) => p.id !== pack.id && p.mods.includes(name)).map((p) => p.name)

  const add = (name: string) => {
    const deps = withDeps ? [...dependencyClosure([name], byName)].filter((d) => !inPack.has(d) && d !== name) : []
    // Una mod solo nell'archivio entra con la versione archiviata più recente bloccata (se non se n'è scelta un'altra)
    const version = name in chosen ? chosen[name] : byName.get(name) ? null : (archiveOf.get(name)?.versions[0]?.version ?? null)
    const versions = version ? { ...pack.versions, [name]: version } : pack.versions
    props.onSave({ mods: [...pack.mods, name, ...deps], versions })
    setAdded((a) => ({ ...a, [name]: [name, ...deps] }))
  }
  const undo = (name: string) => {
    const remove = new Set(added[name] ?? [name])
    const versions = Object.fromEntries(Object.entries(pack.versions).filter(([n]) => !remove.has(n)))
    props.onSave({ mods: pack.mods.filter((m) => !remove.has(m)), versions })
    setAdded((a) => {
      const next = { ...a }
      delete next[name]
      return next
    })
  }

  return (
    <div className="stack">
      <div className="mods-toolbar">
        <label className="search-box">
          <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input type="search" placeholder="Cerca tra le mod del server…" aria-label="Cerca tra le mod del server" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <Link className="btn" to={`../../workshop?pack=${pack.id}`} relative="path">
          <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3v11" />
            <path d="M7.5 9.5L12 14l4.5-4.5" />
            <path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />
          </svg>
          Cerca nel Workshop
        </Link>
        <AddEnabledButton pack={pack} byName={byName} saving={props.saving} onAdd={addEnabled} />
        <label className="checkbox pack-deps-toggle">
          <input type="checkbox" checked={withDeps} onChange={(e) => setWithDeps(e.target.checked)} />
          Aggiungi anche le dipendenze
        </label>
      </div>
      {bulk && (
        <div className="alert alert-success pack-alert">
          <span>
            {bulk.length === 1 ? 'Aggiunta 1 mod abilitata' : `Aggiunte ${bulk.length} mod abilitate`}: {bulk.map(nameOf).join(', ')}.
          </span>
          <button type="button" className="btn btn-sm btn-ghost" disabled={props.saving} onClick={undoBulk}>
            Annulla
          </button>
        </div>
      )}
      <p className="muted small">
        Mod del server che non sono ancora nel pack. Non trovi quella che cerchi? «Cerca nel Workshop» la installa e la aggiunge a
        questo pack.
      </p>

      {candidates.length === 0 ? (
        <div className="empty">{query ? 'Nessuna mod corrisponde alla ricerca.' : 'Tutte le mod del server sono già nel pack.'}</div>
      ) : (
        <div className="mod-grid">
          {candidates.map((name) => {
            const mod = byName.get(name)
            const others = otherPacksOf(name)
            const deps = [...dependencyClosure([name], byName)].filter((d) => !inPack.has(d) || added[name]?.includes(d)).filter((d) => d !== name)
            const isAdded = Boolean(added[name])
            const jobItem = activeJobItem(job.data, (i) => i.name === name)
            return (
              <PackModCard
                key={name}
                serverId={props.serverId}
                name={name}
                title={nameOf(name)}
                mod={mod}
                highlight={isAdded}
                pills={
                  <>
                    {mod?.version ? <span className="pill pill-plain">v{mod.version}</span> : <span className="pill pill-plain">solo nell'archivio</span>}
                    {others.length > 0 && <span className="pill pill-off">In «{others[0]}»{others.length > 1 ? ` +${others.length - 1}` : ''}</span>}
                  </>
                }
                extra={withDeps && deps.length ? `Porta con sé: ${deps.map(nameOf).join(', ')}` : null}
                version={
                  isAdded ? null : (
                    <div className="pack-version">
                      <span className="pack-version-label">Versione da aggiungere</span>
                      <VersionSelect
                        label={`Versione di ${nameOf(name)} da aggiungere`}
                        installed={mod?.version ?? null}
                        archived={archiveOf.get(name)}
                        value={name in chosen ? chosen[name] : mod ? null : (archiveOf.get(name)?.versions[0]?.version ?? null)}
                        onChange={(v) => setChosen((c) => ({ ...c, [name]: v }))}
                      />
                    </div>
                  )
                }
                actions={
                  <div className="mod-card-actions">
                    {isAdded ? (
                      <>
                        <span className="pill pill-on pack-added-pill">
                          <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M5 12l5 5 9-10" />
                          </svg>
                          Aggiunta{added[name].length > 1 ? ` (+${added[name].length - 1})` : ''}
                        </span>
                        <span className="spacer" />
                        <button type="button" className="btn btn-sm btn-ghost" disabled={props.saving} onClick={() => undo(name)}>
                          Annulla
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          disabled={props.saving || Boolean(jobItem)}
                          onClick={() => add(name)}
                        >
                          <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M12 5v14M5 12h14" />
                          </svg>
                          Aggiungi
                        </button>
                        <span className="spacer" />
                      </>
                    )}
                  </div>
                }
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

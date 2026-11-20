import { useState } from 'react'
import type { WorldEditorCatalogEntry } from '../../lib/types'
import { t } from '../../i18n'

/** "StoneSlab" → "Stone Slab", con la mod se è di una mod. */
const label = (e: WorldEditorCatalogEntry) => `${e.name.replace(/([a-z])([A-Z])/g, '$1 $2')}${e.mod ? ` · ${e.mod}` : ''}${e.object ? ' (oggetto)' : ''} #${e.type}`

/** Scelta del blocco o del muro per l'editor del mondo: campo di ricerca con i suggerimenti del catalogo. */
export default function TypePicker({
  entries,
  value,
  onChange,
  kind,
}: {
  entries: WorldEditorCatalogEntry[]
  value: number
  onChange: (type: number) => void
  kind: string
}) {
  // null: non ancora toccato, mostra la scelta attuale (il catalogo può arrivare dopo)
  const [text, setText] = useState<string | null>(null)
  const current = entries.find((e) => e.type === value)
  const listId = `world-editor-${kind}`
  return (
    <>
      <input
        className="world-editor-type"
        list={listId}
        value={text ?? (current ? label(current) : '')}
        placeholder={t('{kind}: search by name', { kind })}
        aria-label={kind}
        onChange={(e) => {
          setText(e.target.value)
          const match = entries.find((entry) => label(entry) === e.target.value)
          if (match) onChange(match.type)
        }}
        onFocus={(e) => e.target.select()}
      />
      <datalist id={listId}>
        {entries.map((e) => (
          <option key={e.type} value={label(e)} />
        ))}
      </datalist>
    </>
  )
}

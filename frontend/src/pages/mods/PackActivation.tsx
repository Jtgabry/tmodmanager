import { type ActivationProps, usePackActivation } from './usePackActivation'

/** Pulsanti grandi di attivazione, nell'intestazione della pagina del pack. */
export default function PackActivation(props: ActivationProps) {
  const { pack } = props
  const a = usePackActivation(props)
  return (
    <span className="pack-activation pack-activation-hero">
      {pack.active ? (
        <button type="button" className="btn btn-toggle-on" disabled={a.busy} onClick={a.toggle}>
          {a.busy ? 'Un momento…' : 'Disattiva il modpack'}
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-primary"
          disabled={a.busy || props.blocked}
          title="Abilita le mod del pack; le altre mod restano come sono"
          onClick={a.toggle}
        >
          {a.busy ? 'Un momento…' : 'Attiva il modpack'}
        </button>
      )}
      {a.exclusiveUseful && (
        <button
          type="button"
          className="btn"
          disabled={a.busy || props.blocked}
          title="Abilita solo le mod di questo pack e disabilita tutte le altre"
          onClick={a.exclusive}
        >
          Attiva solo questo
        </button>
      )}
      {a.dialog}
    </span>
  )
}

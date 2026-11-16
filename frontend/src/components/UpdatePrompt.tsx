import { useRegisterSW } from 'virtual:pwa-register/react'

/** Ogni quanto controllare se è uscita una nuova versione dell'app (oltre che a ogni apertura). */
const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000

/**
 * Registra il service worker e, quando è pronta una nuova build, mostra un avviso.
 * L'aggiornamento non parte da solo, così non si perde ad esempio un file in modifica.
 */
export default function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return
      setInterval(() => {
        if (navigator.onLine) void registration.update()
      }, UPDATE_CHECK_INTERVAL)
    },
  })

  if (!needRefresh) return null

  return (
    <div className="update-prompt" role="status">
      <span>È disponibile una nuova versione di tModManager.</span>
      <div className="btn-row">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNeedRefresh(false)}>
          Più tardi
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void updateServiceWorker(true)}>
          Aggiorna
        </button>
      </div>
    </div>
  )
}

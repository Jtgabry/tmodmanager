import { useState } from 'react'
import { useReleases, versionLabel } from './admin'
import { type Game, GAME_LABEL, type InstallationChoice, type SwitchRequest, type TmlRelease } from './types'

/**
 * Scelta di gioco e versione per un server (creazione e cambio di versione). Per ogni gioco si propongono:
 *  - l'installazione principale (condivisa: aggiornandola si aggiornano tutti i server che la usano),
 *    installata in automatico se non c'è ancora;
 *  - le versioni fisse già installate (non si aggiornano: ogni server si aggiorna per conto suo);
 *  - le altre versioni pubblicate, che diventano versioni fisse installate in automatico.
 */

const GAMES: Game[] = ['terraria', 'tshock', 'tmodloader']

export type Picked = {
  game: Game
  /** Destinazione per il passaggio (o la creazione). */
  target: SwitchRequest
  /** Installazione esistente scelta, se è una di quelle. */
  choice: InstallationChoice | null
  /** Versione pubblicata scelta (nuova versione fissa da installare), se è una di quelle. */
  release: TmlRelease | null
  /** Va installata prima di poter accendere il server. */
  toInstall: boolean
  /** Versione dei mondi che sa aprire, se nota. */
  worldRelease: number | null
}

const releaseValue = (version: string) => `release:${version}`
const dirValue = (path: string) => `dir:${path}`

/**
 * `current`: installazione attuale del server (cambio di versione), null alla creazione.
 * Restituisce gli elementi del modulo e la scelta corrente.
 */
export function useInstallationPicker(choices: InstallationChoice[], current: { game: Game; installDir: string } | null) {
  const [game, setGame] = useState<Game>(current?.game ?? 'terraria')
  const [value, setValue] = useState<string | null>(current ? dirValue(current.installDir) : null)
  const releases = useReleases(game)

  const installed = choices.filter((c) => c.kind === game)
  // Versioni già presenti (anche come principale): non si ripropongono tra quelle da installare
  const pinnedVersions = new Set(installed.filter((c) => c.pinned).map((c) => c.version))
  const available = (releases.data ?? []).filter((r) => !pinnedVersions.has(r.version))
  // Di default: l'installazione attuale, altrimenti la principale del gioco
  const fallback = installed.find((c) => c.managed && !c.pinned) ?? installed[0]
  const selected = value ?? (fallback ? dirValue(fallback.path) : available[0] ? releaseValue(available[0].version) : '')

  let picked: Picked | null = null
  if (selected.startsWith('dir:')) {
    const choice = choices.find((c) => dirValue(c.path) === selected) ?? null
    if (choice) {
      picked = {
        game: choice.kind,
        target: { installDir: choice.path },
        choice,
        release: null,
        toInstall: !choice.installed,
        worldRelease: choice.installed ? choice.worldRelease : (releases.data?.find((r) => !r.prerelease)?.worldRelease ?? null),
      }
    }
  } else if (selected.startsWith('release:')) {
    const release = available.find((r) => releaseValue(r.version) === selected) ?? null
    if (release) {
      picked = { game, target: { game, version: release.version }, choice: null, release, toInstall: true, worldRelease: release.worldRelease }
    }
  }

  const currentElsewhere = current && !choices.some((c) => c.path === current.installDir)

  const fields = (
    <>
      <label className="field field-narrow">
        <span>Gioco</span>
        <select
          value={game}
          onChange={(e) => {
            const next = e.target.value as Game
            setGame(next)
            setValue(current && current.game === next ? dirValue(current.installDir) : null)
          }}
        >
          {GAMES.map((g) => (
            <option key={g} value={g}>
              {GAME_LABEL[g]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Versione</span>
        <select value={selected} onChange={(e) => setValue(e.target.value)}>
          {currentElsewhere && current.game === game && <option value={dirValue(current.installDir)}>{current.installDir} — attuale</option>}
          {installed.length > 0 && (
            <optgroup label="Nel pannello">
              {installed.map((c) => (
                <option key={c.path} value={dirValue(c.path)}>
                  {versionLabel(c)}
                  {current?.installDir === c.path ? ' · attuale' : ''}
                </option>
              ))}
            </optgroup>
          )}
          {available.length > 0 && (
            <optgroup label="Da installare come versione fissa">
              {available.map((r, index) => (
                <option key={r.version} value={releaseValue(r.version)}>
                  {r.version}
                  {r.prerelease ? ' (beta)' : ''}
                  {game === 'tshock' && r.gameVersion ? ` (Terraria ${r.gameVersion})` : ''}
                  {index === 0 && !r.prerelease ? ' — ultima' : ''}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {releases.isLoading && <span className="muted small">Caricamento delle versioni…</span>}
        {releases.error && <span className="error-text">Versioni pubblicate non disponibili</span>}
      </label>
    </>
  )

  return { fields, picked }
}


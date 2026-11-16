/** Sequenze ANSI (colori, cursore, titolo finestra) che screen può registrare nel log. */
// oxlint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78]/g
// oxlint-disable-next-line no-control-regex
const OTHER_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/**
 * Pulisce l'output grezzo del terminale per mostrarlo come testo:
 * via le sequenze ANSI, e per le righe riscritte con "\r" (es. "Saving world: 45%") si tiene l'ultima versione.
 */
export function cleanTerminalOutput(raw: string): string {
  return raw
    .replace(ANSI, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const parts = line.split('\r').filter((p) => p !== '')
      return (parts.at(-1) ?? '').replace(OTHER_CONTROL, '')
    })
    .join('\n')
}

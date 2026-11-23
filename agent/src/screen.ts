import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export type ScreenSession = { pid: number; name: string }

/**
 * Estrae le sessioni dall'output di `screen -ls` (righe tipo "\t44886.server\t(data)\t(Detached)").
 * Salta i socket morti ("(Dead ???)", es. rimasti dopo un riavvio forzato): non c'è nessuna sessione dietro.
 */
export function parseScreenList(output: string): ScreenSession[] {
  const sessions: ScreenSession[] = []
  for (const line of output.split('\n')) {
    if (/\(Dead\b/i.test(line)) continue
    const match = line.match(/^\s+(\d+)\.(\S+)\s+\(/)
    if (match) sessions.push({ pid: Number(match[1]), name: match[2] })
  }
  return sessions
}

export async function listSessions(): Promise<ScreenSession[]> {
  try {
    return parseScreenList((await run('screen', ['-ls'])).stdout)
  } catch (err) {
    // screen -ls esce con codice 1 quando non ci sono sessioni (e su alcune versioni anche quando ci sono)
    return parseScreenList((err as { stdout?: string }).stdout ?? '')
  }
}

/** Rimuove i socket di sessioni morte (screen -wipe esce con codice != 0 anche quando va bene). */
export async function wipeDeadSessions() {
  await run('screen', ['-wipe']).catch(() => undefined)
}

const target = (s: ScreenSession) => `${s.pid}.${s.name}`

/**
 * Configurazione di screen per le sessioni dei server. Va passata all'avvio: "logfile flush"
 * dato dopo con -X vale solo dal primo flush (10s di default), e la console resterebbe vuota.
 */
const SCREENRC = ['logfile flush 1', 'defscrollback 10000', 'defutf8 on', ''].join('\n')

/**
 * Avvia una sessione detached che esegue direttamente `command` (senza shell) e registra l'output in logFile.
 * `rcFile` viene (ri)scritto con SCREENRC. `extraEnv`: variabili in più per il server (es. DOTNET_ROOT).
 */
export async function startSession(name: string, cwd: string, logFile: string, rcFile: string, command: string[], extraEnv: Record<string, string> = {}) {
  await mkdir(dirname(rcFile), { recursive: true })
  await writeFile(rcFile, SCREENRC)
  // Il server non deve ereditare la configurazione dell'agent (token compreso)
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENT_'))), ...extraEnv }
  await run('screen', ['-c', rcFile, '-dmS', name, '-L', '-Logfile', logFile, ...command], { cwd, env })
}

/**
 * screen interpreta "^X" come tasto di controllo (es. "^C" = Ctrl+C), "\\" come escape e "$VAR" come variabile.
 * Va tutto reso letterale, altrimenti un "say ^C" interromperebbe il server.
 */
export const escapeStuff = (text: string) => text.replace(/[\\^$]/g, (c) => `\\${c}`)

/** Scrive testo nella finestra 0 della sessione, come se fosse digitato (i caratteri speciali restano letterali). */
export async function stuff(session: ScreenSession, text: string) {
  await run('screen', ['-S', target(session), '-p', '0', '-X', 'stuff', escapeStuff(text)])
}

/** Digita una riga e preme Invio. */
export async function sendLine(session: ScreenSession, line: string) {
  await run('screen', ['-S', target(session), '-p', '0', '-X', 'stuff', `${escapeStuff(line)}\r`])
}

/** Salva su file lo schermo corrente più tutto lo scrollback. */
export async function hardcopy(session: ScreenSession, file: string) {
  await run('screen', ['-S', target(session), '-p', '0', '-X', 'hardcopy', '-h', file])
}

/**
 * Attiva il log della finestra 0 su file, con flush ogni secondo.
 * Solo per sessioni senza log: su una sessione già in log, cambiare logfile lo chiude senza riaprirlo.
 */
export async function enableLogging(session: ScreenSession, file: string) {
  const x = (...args: string[]) => run('screen', ['-S', target(session), '-p', '0', '-X', ...args])
  await x('logfile', file)
  await x('logfile', 'flush', '1')
  await x('log', 'on')
}

export async function quitSession(session: ScreenSession) {
  await run('screen', ['-S', target(session), '-X', 'quit'])
}

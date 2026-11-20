import { useMutation } from '@tanstack/react-query'
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { api, errorMessage } from '../lib/api'
import { useConsoleStream } from '../lib/consoleStream'
import { useCurrentServer } from '../lib/currentServer'
import { t } from '../i18n'

const quickCommands = () => [
  { label: t('Save'), command: 'save' },
  { label: t('Players'), command: 'playing' },
  { label: t('Time'), command: 'time' },
  { label: t('Version'), command: 'version' },
]

const modeLabel = (mode: 'live' | 'connecting' | 'polling') =>
  ({
    live: { text: t('Live'), className: 'tag tag-active' },
    connecting: { text: t('Connecting…'), className: 'tag' },
    polling: { text: t('Refreshing every second'), className: 'tag tag-warning' },
  })[mode]

export default function ConsoleTab() {
  const server = useCurrentServer()
  const { can } = useAuth()
  const { output, setOutput, mode, error: streamError } = useConsoleStream(server.id)
  const [command, setCommand] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const historyIndex = useRef<number | null>(null)
  const outputRef = useRef<HTMLPreElement>(null)
  const stickToBottom = useRef(true)
  const isOn = server.state !== 'stopped'

  useEffect(() => {
    const el = outputRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [output])

  const onScroll = () => {
    const el = outputRef.current
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  const send = useMutation({
    mutationFn: (line: string) => api.post(`/servers/${server.id}/console`, { command: line }),
  })

  const submit = useCallback(
    (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return
      send.mutate(trimmed, {
        onSuccess: () => {
          setHistory((h) => [...h.filter((c) => c !== trimmed), trimmed].slice(-50))
          setCommand('')
          historyIndex.current = null
          stickToBottom.current = true
        },
      })
    },
    [send],
  )

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    submit(command)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    if (history.length === 0) return
    e.preventDefault()
    const current = historyIndex.current ?? history.length
    const next = e.key === 'ArrowUp' ? Math.max(0, current - 1) : Math.min(history.length, current + 1)
    historyIndex.current = next === history.length ? null : next
    setCommand(next === history.length ? '' : history[next])
  }

  const isExit = /^\s*exit(-nosave)?\b/i.test(command)

  return (
    <div className="console card">
      <div className="console-toolbar">
        <div className="btn-row">
          {quickCommands().map((q) => (
            <button key={q.command} type="button" className="btn btn-sm" disabled={!isOn || send.isPending} onClick={() => submit(q.command)}>
              {q.label}
            </button>
          ))}
        </div>
        <div className="btn-row">
          <span
            className={modeLabel(mode).className}
            title={mode === 'polling' ? t('WebSocket not available: the console is refreshed every second') : undefined}
          >
            {modeLabel(mode).text}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOutput('')}>
            {t('Clear')}
          </button>
        </div>
      </div>

      <pre ref={outputRef} className="console-output" onScroll={onScroll} aria-live="polite">
        {output || <span className="muted">{t('No output.')}</span>}
      </pre>

      {streamError && mode !== 'live' && <p className="error-text">{t('Console refresh: {error}', { error: streamError })}</p>}

      <form className="console-input" onSubmit={onSubmit}>
        <span className="prompt">&gt;</span>
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={isOn ? t('Command (e.g. say Hello everyone) — ↑/↓ for history') : t('The server is stopped')}
          disabled={!isOn}
          maxLength={500}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="btn btn-primary" disabled={!isOn || send.isPending || !command.trim()}>
          {t('Send')}
        </button>
      </form>
      {isExit && (
        <p className="hint">
          {can(server.id, 'power')
            ? t('Warning: "exit" stops the server (better to use the Stop button).')
            : t('You do not have permission to stop the server.')}
        </p>
      )}
      {send.isError && <p className="error-text">{errorMessage(send.error)}</p>}
    </div>
  )
}

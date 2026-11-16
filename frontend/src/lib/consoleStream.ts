import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from './api'
import { cleanTerminalOutput } from './terminal'

type ConsoleChunk = { offset: number; data: string; reset: boolean }

/** Oltre questa dimensione si tiene solo la parte finale dell'output. */
const MAX_BUFFER = 300_000
const POLL_MS = 1000
/** Tentativi WebSocket falliti di fila (senza mai aprirsi) prima di passare al polling. */
const MAX_WS_FAILURES = 3

export type StreamMode = 'connecting' | 'live' | 'polling'

/**
 * Output della console in tempo reale.
 * Prima prova il WebSocket (ticket da Laravel → wss://…/ws/servers/<id>/console); se non funziona
 * (es. proxy di Apache non configurato) ripiega sul polling HTTP ogni secondo.
 */
export function useConsoleStream(serverId: string) {
  const [output, setOutput] = useState('')
  const [mode, setMode] = useState<StreamMode>('connecting')
  const [error, setError] = useState<string | null>(null)
  const pending = useRef('')

  useEffect(() => {
    let cancelled = false
    let socket: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    let offset: number | null = null
    pending.current = ''

    const apply = (chunk: ConsoleChunk) => {
      offset = chunk.offset
      // L'ultima riga può arrivare a metà: la si tiene da parte finché non arriva il suo "\n"
      const raw = (chunk.reset ? '' : pending.current) + chunk.data
      const cut = raw.lastIndexOf('\n') + 1
      pending.current = raw.slice(cut)
      const text = cleanTerminalOutput(raw.slice(0, cut))
      if (chunk.reset) setOutput(text)
      else if (text) setOutput((prev) => (prev + text).slice(-MAX_BUFFER))
    }

    const poll = async () => {
      if (cancelled) return
      if (!document.hidden) {
        try {
          const params = offset === null ? {} : { offset }
          const { data } = await api.get<{ data: ConsoleChunk }>(`/servers/${serverId}/console`, { params })
          if (cancelled) return
          apply(data.data)
          setError(null)
        } catch (err) {
          if (!cancelled) setError(errorMessage(err))
        }
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS)
    }

    const startPolling = () => {
      setMode('polling')
      // Riparte dalla coda del log (reset) per non perdere né duplicare righe
      offset = null
      void poll()
    }

    const connect = async () => {
      if (cancelled) return
      setMode('connecting')
      let path: string
      try {
        path = (await api.post<{ data: { path: string } }>(`/servers/${serverId}/console/ticket`)).data.data.path
      } catch (err) {
        if (cancelled) return
        setError(errorMessage(err))
        failures++
        if (failures >= MAX_WS_FAILURES) startPolling()
        else timer = setTimeout(connect, 1000 * failures)
        return
      }
      if (cancelled) return

      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`
      let opened = false
      socket = new WebSocket(url)
      socket.onopen = () => {
        opened = true
        failures = 0
        setMode('live')
        setError(null)
      }
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { type: string } & ConsoleChunk
          if (message.type === 'chunk') apply(message)
        } catch {
          // messaggio non valido: ignorato
        }
      }
      socket.onclose = (event) => {
        socket = null
        if (cancelled) return
        if (!opened) failures++
        if (failures >= MAX_WS_FAILURES) {
          startPolling()
          return
        }
        // 4001 = sessione scaduta (riconnessione immediata con un ticket nuovo); altrimenti breve attesa
        setMode('connecting')
        timer = setTimeout(connect, event.code === 4001 ? 0 : 1000 * Math.max(1, failures))
      }
    }

    void connect()
    return () => {
      cancelled = true
      clearTimeout(timer)
      socket?.close()
    }
  }, [serverId])

  return { output, setOutput, mode, error }
}

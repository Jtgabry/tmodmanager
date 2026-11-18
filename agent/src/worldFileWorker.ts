import { parentPort, workerData } from 'node:worker_threads'
import { type RenderJob, renderWorldFile } from './worldFileRender.js'

// Worker thread: legge e disegna un file del mondo senza bloccare l'agent (vedi worldFileMap.ts)
renderWorldFile(workerData as RenderJob).then(
  (result) => parentPort?.postMessage({ ok: true, result }),
  (err: unknown) => parentPort?.postMessage({ ok: false, message: err instanceof Error ? err.message : String(err) }),
)

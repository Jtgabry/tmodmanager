import { useEffect, useRef, useState } from 'react'

const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false

/**
 * Trascinamento di file su tutta la finestra: `dragging` mentre un file è sopra la pagina,
 * `onFiles` al rilascio. Il contatore serve perché dragenter/dragleave scattano su ogni elemento attraversato.
 */
export function useWindowFileDrop(onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const onFilesRef = useRef(onFiles)

  useEffect(() => {
    onFilesRef.current = onFiles
  })

  useEffect(() => {
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current += 1
      setDragging(true)
    }
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return
      // Senza preventDefault il browser aprirebbe il file al rilascio
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setDragging(false)
      onFilesRef.current([...(e.dataTransfer?.files ?? [])])
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
      depth.current = 0
      setDragging(false)
    }
  }, [])

  return dragging
}

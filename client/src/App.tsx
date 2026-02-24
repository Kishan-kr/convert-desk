import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type Status = 'idle' | 'uploading' | 'queued' | 'processing' | 'ready' | 'error'

type ProgressPayload = {
  status: Status | 'error'
  message?: string
  progress?: number | null
  queue_position?: number | null
  download_url?: string
  output_name?: string
  error?: string
}

const MAX_FILE_MB = 500

const statusCopy: Record<Status, string> = {
  idle: 'Drop a .mov file to start.',
  uploading: 'Uploading to the server.',
  queued: 'Queued for conversion.',
  processing: 'Converting with ffmpeg.',
  ready: 'Your MP4 is ready to download.',
  error: 'Something went wrong. Try again.',
}

function formatBytes(bytes: number) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function App() {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)
  const [outputName, setOutputName] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [convertProgress, setConvertProgress] = useState<number | null>(null)
  const [queuePosition, setQueuePosition] = useState<number | null>(null)
  const [serverMessage, setServerMessage] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)

  const fileSize = useMemo(() => (selectedFile ? formatBytes(selectedFile.size) : '-'), [selectedFile])

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
      }
    }
  }, [])

  const resetDownload = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
    setDownloadUrl(null)
    setOutputName(null)
    setUploadProgress(0)
    setConvertProgress(null)
    setQueuePosition(null)
    setServerMessage(null)
    setJobId(null)
  }

  const handleFile = (file: File | null) => {
    if (!file) return
    const lower = file.name.toLowerCase()
    if (!lower.endsWith('.mov')) {
      setError('Please choose a .mov file.')
      setStatus('error')
      return
    }
    resetDownload()
    setSelectedFile(file)
    setStatus('idle')
    setError(null)
  }

  const onBrowse = () => inputRef.current?.click()

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDragging(false)
    const file = event.dataTransfer.files?.[0]
    handleFile(file ?? null)
  }

  const onDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDragging(true)
  }

  const onDragLeave = () => setIsDragging(false)

  const startProgressStream = (id: string) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
    }

    const source = new EventSource(`/api/progress/${id}`)
    eventSourceRef.current = source

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as ProgressPayload
        if (payload.message) {
          setServerMessage(payload.message)
        }
        if (payload.status === 'queued') {
          setStatus('queued')
          setQueuePosition(payload.queue_position ?? null)
        }
        if (payload.status === 'processing') {
          setStatus('processing')
          setConvertProgress(payload.progress ?? null)
        }
        if (payload.status === 'ready') {
          setStatus('ready')
          setConvertProgress(payload.progress ?? 100)
          setDownloadUrl(payload.download_url ?? `/api/download/${id}`)
          setOutputName(payload.output_name ?? `${selectedFile?.name.replace(/\.[^.]+$/, '')}.mp4`)
          source.close()
        }
        if (payload.status === 'error') {
          setStatus('error')
          setError(payload.error || payload.message || 'Conversion failed.')
          source.close()
        }
      } catch (err) {
        setStatus('error')
        setError(err instanceof Error ? err.message : 'Unexpected server response.')
        source.close()
      }
    }

    source.onerror = () => {
      setStatus('error')
      setError('Connection lost while tracking progress.')
      source.close()
    }
  }

  const uploadFile = (file: File) =>
    new Promise<{ jobId: string; queuePosition?: number | null }>((resolve, reject) => {
      const formData = new FormData()
      formData.append('file', file)

      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/convert')
      xhr.responseType = 'json'

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const percent = Math.round((event.loaded / event.total) * 100)
          setUploadProgress(percent)
        }
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const data = (xhr.response || JSON.parse(xhr.responseText)) as { job_id: string; queue_position?: number }
          resolve({ jobId: data.job_id, queuePosition: data.queue_position })
          return
        }
        const responseText = xhr.responseText || ''
        try {
          const data = JSON.parse(responseText) as { error?: string }
          reject(new Error(data.error || `Server error ${xhr.status}`))
        } catch {
          reject(new Error(responseText || `Server error ${xhr.status}`))
        }
      }

      xhr.onerror = () => {
        reject(new Error('Network error while uploading.'))
      }

      xhr.send(formData)
    })

  const onConvert = async () => {
    if (!selectedFile || status === 'uploading' || status === 'processing' || status === 'queued') return
    setStatus('uploading')
    setError(null)
    setServerMessage(null)
    setQueuePosition(null)
    setConvertProgress(null)

    try {
      const result = await uploadFile(selectedFile)
      setJobId(result.jobId)
      setStatus('queued')
      setQueuePosition(result.queuePosition ?? null)
      startProgressStream(result.jobId)
    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : 'Upload failed.')
    }
  }

  const onClear = () => {
    resetDownload()
    setSelectedFile(null)
    setStatus('idle')
    setError(null)
  }

  const progressValue = useMemo(() => {
    if (status === 'uploading') return uploadProgress
    if (status === 'processing') return convertProgress ?? 60
    if (status === 'queued') return 20
    if (status === 'ready') return 100
    return 0
  }, [status, uploadProgress, convertProgress])

  const isIndeterminate = status === 'processing' && convertProgress === null

  const progressLabel = useMemo(() => {
    if (status === 'uploading') return `Uploading ${uploadProgress}%`
    if (status === 'processing' && convertProgress !== null) return `Converting ${convertProgress}%`
    if (status === 'queued') return queuePosition ? `Queue position ${queuePosition}` : 'Waiting in queue'
    if (status === 'ready') return 'Conversion complete'
    return ''
  }, [status, uploadProgress, convertProgress, queuePosition])

  const statusLine = serverMessage || statusCopy[status]

  return (
    <div className="app">
      <div className="orb orb-1" aria-hidden="true" />
      <div className="orb orb-2" aria-hidden="true" />
      <div className="orb orb-3" aria-hidden="true" />

      <main className="relative z-10 mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-10 px-6 py-12">
        <header className="flex flex-col gap-4">
          <span className="badge">MOV to MP4 Converter</span>
          <h1 className="headline">Make your MOV files Android-ready in one pass.</h1>
          <p className="subhead">
            Upload a .mov file, let the server convert it with ffmpeg, and download a crisp MP4.
            No fuss, no clutter.
          </p>
        </header>

        <section className="panel grid gap-6 p-6 md:grid-cols-[1.3fr_1fr]">
          <div
            className={`dropzone ${isDragging ? 'dropzone-active' : ''}`}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => event.key === 'Enter' && onBrowse()}
          >
            <div className="drop-visual">
              <div className="drop-ring" />
              <div className="drop-core" />
            </div>
            <div className="drop-copy">
              <p className="drop-title">{selectedFile ? 'File locked in.' : 'Drag and drop your .mov file.'}</p>
              <p className="drop-sub">
                {selectedFile ? `${selectedFile.name} • ${fileSize}` : 'Or click to browse your computer.'}
              </p>
            </div>
            <button className="btn btn-ghost" type="button" onClick={onBrowse}>
              Choose file
            </button>
            <input
              ref={inputRef}
              className="hidden"
              type="file"
              accept=".mov,video/quicktime"
              onChange={(event) => handleFile(event.target.files?.[0] ?? null)}
            />
          </div>

          <div className="panel-side">
            <div className="status-pill">
              <span className={`status-dot status-${status}`} />
              <span>{statusLine}</span>
            </div>

            <div className="meter">
              <div
                className={`meter-bar meter-${status} ${isIndeterminate ? 'meter-indeterminate' : ''}`}
                style={isIndeterminate ? undefined : { width: `${progressValue}%` }}
              />
            </div>
            {progressLabel ? <p className="progress-label">{progressLabel}</p> : null}

            {error ? <div className="error">{error}</div> : null}

            <div className="file-card">
              <div>
                <p className="label">Selected file</p>
                <p className="value">{selectedFile ? selectedFile.name : 'Nothing yet'}</p>
              </div>
              <div>
                <p className="label">Size</p>
                <p className="value">{selectedFile ? fileSize : '-'}</p>
              </div>
              <div>
                <p className="label">Output</p>
                <p className="value">{outputName ?? 'MP4 (h.264 + AAC)'}</p>
              </div>
              <div>
                <p className="label">Job ID</p>
                <p className="value">{jobId ?? '-'}</p>
              </div>
            </div>

            <div className="actions">
              <button
                className="btn btn-primary"
                type="button"
                onClick={onConvert}
                disabled={!selectedFile || status === 'uploading' || status === 'processing' || status === 'queued'}
              >
                {status === 'uploading' ? 'Uploading...' : status === 'processing' ? 'Converting...' : 'Convert to MP4'}
              </button>

              {downloadUrl ? (
                <a className="btn btn-secondary" href={downloadUrl} download={outputName ?? undefined}>
                  Download MP4
                </a>
              ) : null}

              <button className="btn btn-ghost" type="button" onClick={onClear} disabled={!selectedFile}>
                Clear
              </button>
            </div>

            <p className="hint">Tip: Keep files under {MAX_FILE_MB} MB for faster conversions.</p>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          <div className="step-card">
            <p className="step-title">1. Upload</p>
            <p className="step-body">Drop a .mov file or browse your machine.</p>
          </div>
          <div className="step-card">
            <p className="step-title">2. Convert</p>
            <p className="step-body">Server runs ffmpeg for Android compatible MP4.</p>
          </div>
          <div className="step-card">
            <p className="step-title">3. Download</p>
            <p className="step-body">Grab the MP4 and share immediately.</p>
          </div>
        </section>
      </main>
    </div>
  )
}

export default App

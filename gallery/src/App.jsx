import { useState, useEffect, useRef, useCallback } from 'preact/hooks'
import QRCode from 'qrcode'

const PORT = 8081
const POLL_MS = 5000
const STORAGE_KEY = 'photobooth_server_ip'
const FRAME_COLORS = ['#e5e7eb', '#ef4444', '#3b82f6', '#22c55e', '#eab308']

// ── Utilities ──────────────────────────────────────────────────────────────

function photoUrl(ip, filename) {
  return `http://${ip}:${PORT}/photos/${encodeURIComponent(filename)}`
}

// ── QR code box ────────────────────────────────────────────────────────────

function QrBox({ url }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    if (!url || !canvasRef.current) return
    QRCode.toCanvas(canvasRef.current, url, { width: 160, margin: 1 })
  }, [url])

  if (!url) {
    return (
      <div class="qr-box offline">
        <span class="qr-offline-dot" />
        <span>Saved offline — no QR</span>
      </div>
    )
  }

  return (
    <div class="qr-box">
      <canvas ref={canvasRef} />
      <p class="qr-label">Scan to download</p>
    </div>
  )
}

// ── Color swatches ─────────────────────────────────────────────────────────

function ColorSwatches({ active, onChange }) {
  return (
    <div class="color-swatches">
      {FRAME_COLORS.map((c) => (
        <button
          key={c}
          class={`swatch${c === active ? ' active' : ''}`}
          style={{ backgroundColor: c }}
          aria-label={`Set frame colour ${c}`}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  )
}

// ── Connect screen ─────────────────────────────────────────────────────────

function ConnectScreen({ defaultIp, connecting, error, onConnect }) {
  const [ip, setIp] = useState(defaultIp)

  const handleConnect = () => {
    const trimmed = ip.trim()
    if (trimmed) onConnect(trimmed)
  }

  return (
    <div class="connect-screen">
      <h1>📷 Photobooth Gallery</h1>
      <p>Enter the IP address of the photobooth PC to view the gallery.</p>
      <input
        class={`ip-input${error ? ' error' : ''}`}
        type="text"
        placeholder="192.168.1.x"
        spellcheck={false}
        value={ip}
        onInput={(e) => setIp(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
        autoFocus
      />
      {error && <p class="connect-error">{error}</p>}
      <button class="connect-btn" onClick={handleConnect} disabled={connecting}>
        {connecting ? 'Connecting…' : 'Connect'}
      </button>
    </div>
  )
}

// ── Thumbnail strip ────────────────────────────────────────────────────────

function Thumbs({ photos, selected, ip, onSelect }) {
  if (photos.length <= 1) return null
  return (
    <div class="thumbs">
      {photos.map((p, i) => (
        <img
          key={p.filename}
          class={`thumb${i === selected ? ' active' : ''}`}
          src={photoUrl(ip, p.filename)}
          alt={p.filename}
          onClick={() => onSelect(i)}
        />
      ))}
    </div>
  )
}

// ── Gallery screen ─────────────────────────────────────────────────────────

function GalleryScreen({ photos, selected, ip, liveStatus, frameColor, onSelect, onDisconnect, onDelete, onColorChange, deleting }) {
  const photo = photos[selected]
  const previewRef = useRef(null)

  useEffect(() => {
    if (!previewRef.current) return
    previewRef.current.style.animation = 'none'
    void previewRef.current.offsetWidth
    previewRef.current.style.animation = ''
  }, [selected, photo?.filename])

  return (
    <div class="gallery-screen">
      <div class="gallery-header">
        <button class="change-server-btn" onClick={onDisconnect}>← Change server</button>
        <h2>Get your picture here!</h2>
        <div class="live-badge">
          <span class={`live-dot ${liveStatus}`} />
          <span>{liveStatus === 'live' ? `Live · ${ip}` : 'Disconnected'}</span>
        </div>
      </div>

      {photos.length === 0 ? (
        <div class="state-msg">
          <p>No photos yet.</p>
          <small>Photos appear here after they are taken on the photobooth.</small>
        </div>
      ) : (
        <div class="gallery-body">
          <Thumbs photos={photos} selected={selected} ip={ip} onSelect={onSelect} />

          <div class="preview-col">
            <div class="preview-row">
              <div class="photo-frame" style={{ backgroundColor: frameColor }}>
                <img
                  ref={previewRef}
                  class="preview-img"
                  src={photoUrl(ip, photo.filename)}
                  alt={photo.filename}
                />
              </div>

              <div class="side-col">
                <QrBox url={photo.url} />
                <ColorSwatches active={frameColor} onChange={onColorChange} />
              </div>
            </div>

            <div class="info-box">
              <p class="capture-time">{new Date(photo.mtime * 1000).toLocaleString()}</p>
              <div class="actions">
                <a
                  class="btn btn-download"
                  href={photoUrl(ip, photo.filename)}
                  download={photo.filename}
                >
                  Download
                </a>
                <button
                  class="btn btn-delete"
                  onClick={onDelete}
                  disabled={deleting}
                >
                  {deleting ? '…' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Root app ───────────────────────────────────────────────────────────────

export function App() {
  const [serverIp, setServerIp] = useState(() => localStorage.getItem(STORAGE_KEY) ?? 'localhost')
  const [connected, setConnected] = useState(false)
  const [photos, setPhotos] = useState([])
  const [selected, setSelected] = useState(0)
  const [liveStatus, setLiveStatus] = useState('offline')
  const [connectError, setConnectError] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [frameColor, setFrameColor] = useState(FRAME_COLORS[0])
  const pollRef = useRef(null)
  const ipRef = useRef(serverIp)

  const fetchPhotos = useCallback(async (ip) => {
    try {
      const res = await fetch(`http://${ip}:${PORT}/photos`, { signal: AbortSignal.timeout(4000) })
      if (!res.ok) throw new Error()
      const data = await res.json()
      setLiveStatus('live')
      setPhotos((prev) => {
        if (data.length > prev.length) setSelected(0)
        return data
      })
    } catch {
      setLiveStatus('offline')
    }
  }, [])

  // Auto-connect if IP saved from last session
  useEffect(() => {
    if (serverIp) attemptConnect(serverIp)
  }, [])

  async function attemptConnect(ip) {
    setConnecting(true)
    setConnectError('')
    try {
      const res = await fetch(`http://${ip}:${PORT}/photos`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      ipRef.current = ip
      setServerIp(ip)
      localStorage.setItem(STORAGE_KEY, ip)
      setPhotos(data)
      setSelected(0)
      setConnected(true)
      setLiveStatus('live')
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(() => fetchPhotos(ip), POLL_MS)
    } catch {
      setConnectError('Could not connect. Check the IP and make sure the photobooth backend is running.')
    } finally {
      setConnecting(false)
    }
  }

  function disconnect() {
    if (pollRef.current) clearInterval(pollRef.current)
    setConnected(false)
    setLiveStatus('offline')
    setPhotos([])
  }

  async function deleteSelected() {
    const photo = photos[selected]
    if (!photo) return
    setDeleting(true)
    try {
      const res = await fetch(`http://${serverIp}:${PORT}/photos/${encodeURIComponent(photo.filename)}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setPhotos((prev) => {
        const next = prev.filter((_, i) => i !== selected)
        setSelected((s) => Math.max(0, Math.min(s, next.length - 1)))
        return next
      })
    } catch (e) {
      alert('Delete failed: ' + e.message)
    } finally {
      setDeleting(false)
    }
  }

  if (!connected) {
    return (
      <ConnectScreen
        defaultIp={serverIp}
        connecting={connecting}
        error={connectError}
        onConnect={attemptConnect}
      />
    )
  }

  return (
    <GalleryScreen
      photos={photos}
      selected={selected}
      ip={serverIp}
      liveStatus={liveStatus}
      frameColor={frameColor}
      onSelect={setSelected}
      onDisconnect={disconnect}
      onDelete={deleteSelected}
      onColorChange={setFrameColor}
      deleting={deleting}
    />
  )
}

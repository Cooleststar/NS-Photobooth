import { useState, useEffect, useRef, useCallback } from 'preact/hooks'
import QRCode from 'qrcode'
import logo11Url from './assets/11logo.png'
import fusionLogoUrl from './assets/fusionlogo.png'

const PORT = 8081
const POLL_MS = 5000
const STORAGE_KEY = 'photobooth_server_ip'

// Must match photoStrip.ts constants exactly
const PADDING = 24
const GAP = 10
const FOOTER_HEIGHT = 230
const BRAND_TEXT = 'NS Photobooth'
const QR_SIZE = 120
const QR_MARGIN = 20
const LOGO_SIZE = 180
const LOGO_GAP = 12
const IMG_FORMAT = 'image/webp'
const IMG_QUALITY = 0.92

export const STRIP_BG_OPTIONS = ['#ffffff', '#f6dade', '#dbe8dd', '#dbe4ef', '#f2ebe1']

// ── Strip rendering (mirrors photoStrip.ts) ────────────────────────────────

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

let brandLogosPromise = null
function loadBrandLogos() {
  if (!brandLogosPromise) {
    brandLogosPromise = Promise.all([loadImage(logo11Url), loadImage(fusionLogoUrl)])
  }
  return brandLogosPromise
}

function footerQrBox(canvasWidth, canvasHeight) {
  const x = canvasWidth - QR_MARGIN - QR_SIZE
  const y = canvasHeight - FOOTER_HEIGHT / 2 - QR_SIZE / 2
  return { x, y, size: QR_SIZE }
}

function formatDateTime(timestamp) {
  const d = new Date(timestamp)
  const date = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`
  let hours = d.getHours()
  const ampm = hours >= 12 ? 'PM' : 'AM'
  hours = hours % 12 || 12
  const minutes = String(d.getMinutes()).padStart(2, '0')
  return `${date}  ${hours}:${minutes} ${ampm}`
}

async function drawFooter(ctx, canvasWidth, canvasHeight, timestamp) {
  const rowY = canvasHeight - FOOTER_HEIGHT / 2
  ctx.fillStyle = '#3f3a35'
  ctx.font = 'italic 50px Georgia, serif'
  ctx.textBaseline = 'bottom'
  ctx.textAlign = 'left'
  ctx.fillText(`${BRAND_TEXT}   ${formatDateTime(timestamp)}`, PADDING, canvasHeight - PADDING)

  const { x: qrX } = footerQrBox(canvasWidth, canvasHeight)
  const logoY = rowY - LOGO_SIZE / 2
  const fusionX = qrX - QR_MARGIN - LOGO_SIZE
  const logo11X = fusionX - LOGO_GAP - LOGO_SIZE

  const [logo11Img, fusionLogoImg] = await loadBrandLogos()
  ctx.drawImage(logo11Img, logo11X, logoY, LOGO_SIZE, LOGO_SIZE)
  ctx.drawImage(fusionLogoImg, fusionX, logoY, LOGO_SIZE, LOGO_SIZE)
}

async function createPhotoStrip(images, bgColor = '#ffffff', timestamp = Date.now()) {
  const loaded = await Promise.all(images.map(loadImage))
  const photoWidth = Math.max(...loaded.map((img) => img.width))
  const totalPhotoHeight = loaded.reduce((sum, img) => sum + img.height, 0)

  const canvas = document.createElement('canvas')
  canvas.width = photoWidth + PADDING * 2
  canvas.height = totalPhotoHeight + GAP * (loaded.length - 1) + PADDING * 2 + FOOTER_HEIGHT

  const ctx = canvas.getContext('2d')
  ctx.fillStyle = bgColor
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  let y = PADDING
  for (const img of loaded) {
    const x = (canvas.width - img.width) / 2
    ctx.drawImage(img, x, y)
    y += img.height + GAP
  }

  await drawFooter(ctx, canvas.width, canvas.height, timestamp)
  return canvas.toDataURL(IMG_FORMAT, IMG_QUALITY)
}

async function addQrToStrip(stripDataUrl, qrValue) {
  const strip = await loadImage(stripDataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = strip.width
  canvas.height = strip.height
  const ctx = canvas.getContext('2d')
  ctx.drawImage(strip, 0, 0)

  const { x, y, size } = footerQrBox(canvas.width, canvas.height)
  const qrPadding = 8
  ctx.fillStyle = 'white'
  ctx.fillRect(x - qrPadding, y - qrPadding, size + qrPadding * 2, size + qrPadding * 2)

  const qrDataUrl = await QRCode.toDataURL(qrValue, { margin: 0, width: size })
  const qrImg = await loadImage(qrDataUrl)
  ctx.drawImage(qrImg, x, y, size, size)

  return canvas.toDataURL(IMG_FORMAT, IMG_QUALITY)
}

// ── Utilities ──────────────────────────────────────────────────────────────

function photoUrl(ip, filename, ver = 0) {
  const base = `http://${ip}:${PORT}/photos/${encodeURIComponent(filename)}`
  return ver ? `${base}?v=${ver}` : base
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

function ColorSwatches({ active, onChange, disabled }) {
  return (
    <div class="color-swatches">
      {STRIP_BG_OPTIONS.map((c) => (
        <button
          key={c}
          class={`swatch${c === active ? ' active' : ''}`}
          style={{ backgroundColor: c }}
          aria-label={`Set strip colour ${c}`}
          onClick={() => onChange(c)}
          disabled={disabled}
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

function Thumbs({ photos, selected, ip, versions, onSelect }) {
  if (photos.length <= 1) return null
  return (
    <div class="thumbs">
      {photos.map((p, i) => (
        <img
          key={p.filename}
          class={`thumb${i === selected ? ' active' : ''}`}
          src={photoUrl(ip, p.filename, versions[p.filename] ?? 0)}
          alt={p.filename}
          onClick={() => onSelect(i)}
        />
      ))}
    </div>
  )
}

// ── Gallery screen ─────────────────────────────────────────────────────────

function GalleryScreen({
  photos, selected, ip, liveStatus, stripColors, versions,
  recoloring, onSelect, onDisconnect, onDelete, onColorChange, deleting,
}) {
  const photo = photos[selected]
  const previewRef = useRef(null)

  useEffect(() => {
    if (!previewRef.current) return
    previewRef.current.style.animation = 'none'
    void previewRef.current.offsetWidth
    previewRef.current.style.animation = ''
  }, [selected, photo?.filename, versions[photo?.filename]])

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
          <Thumbs photos={photos} selected={selected} ip={ip} versions={versions} onSelect={onSelect} />

          <div class="preview-col">
            <div class="preview-row">
              <div class="photo-frame">
                {recoloring && <div class="recoloring-overlay">Updating colour…</div>}
                <img
                  ref={previewRef}
                  class="preview-img"
                  src={photoUrl(ip, photo.filename, versions[photo.filename] ?? 0)}
                  alt={photo.filename}
                />
              </div>

              <div class="side-col">
                <QrBox url={photo.url} />
                <ColorSwatches
                  active={stripColors[photo.filename] ?? STRIP_BG_OPTIONS[0]}
                  onChange={(color) => onColorChange(photo, color)}
                  disabled={recoloring}
                />
              </div>
            </div>

            <div class="info-box">
              <p class="capture-time">{new Date(photo.mtime * 1000).toLocaleString()}</p>
              <div class="actions">
                <a
                  class="btn btn-download"
                  href={photoUrl(ip, photo.filename, versions[photo.filename] ?? 0)}
                  download={photo.filename}
                >
                  Download
                </a>
                <button
                  class="btn btn-delete"
                  onClick={onDelete}
                  disabled={deleting || recoloring}
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
  const [recoloring, setRecoloring] = useState(false)
  // per-filename active swatch color (tracks what color user last applied)
  const [stripColors, setStripColors] = useState({})
  // per-filename version counter for cache-busting after recolor
  const [versions, setVersions] = useState({})
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

  async function handleColorChange(photo, color) {
    const current = stripColors[photo.filename] ?? STRIP_BG_OPTIONS[0]
    if (color === current || recoloring) return
    setRecoloring(true)
    try {
      // Fetch raw strip photos from backend
      const res = await fetch(
        `http://${serverIp}:${PORT}/photos/${encodeURIComponent(photo.filename)}/strips`,
        { signal: AbortSignal.timeout(15000) },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { stripPhotos } = await res.json()
      if (!stripPhotos || stripPhotos.length === 0) {
        alert('No original photos stored for recoloring. Take a new photo to enable this feature.')
        return
      }

      // Regenerate the strip with the new background color
      let newStrip = await createPhotoStrip(stripPhotos, color, photo.timestamp || Date.now())

      // Rebake the QR using the same Cloudinary URL (no re-upload needed)
      if (photo.url) {
        newStrip = await addQrToStrip(newStrip, photo.url)
      }

      // Replace the file on the backend so all viewers see the updated image
      const putRes = await fetch(
        `http://${serverIp}:${PORT}/photos/${encodeURIComponent(photo.filename)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: newStrip }),
        },
      )
      if (!putRes.ok) throw new Error(`HTTP ${putRes.status}`)

      // Track the color and bust the cache so the <img> reloads
      setStripColors((prev) => ({ ...prev, [photo.filename]: color }))
      setVersions((prev) => ({ ...prev, [photo.filename]: Date.now() }))
    } catch (e) {
      alert('Recolor failed: ' + e.message)
    } finally {
      setRecoloring(false)
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
      stripColors={stripColors}
      versions={versions}
      recoloring={recoloring}
      onSelect={setSelected}
      onDisconnect={disconnect}
      onDelete={deleteSelected}
      onColorChange={handleColorChange}
      deleting={deleting}
    />
  )
}

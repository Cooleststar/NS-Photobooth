import { useState, useEffect, useRef, useCallback } from 'preact/hooks'
import QRCode from 'qrcode'
import logo11Url from './assets/11logo.png'
import fusionLogoUrl from './assets/fusionlogo.png'

const PORT = 8081
const POLL_MS = 5000
const STORAGE_KEY = 'photobooth_server_ip'
const THEME_KEY = 'photobooth_gallery_theme'

// Must match photoStrip.ts constants exactly
// Photos sit flush to the strip edge - photoStrip.ts uses SIDE_PADDING = 0 /
// TOP_PADDING = 0. A non-zero value here drew a border of the strip's
// background colour (white by default) around every photo on recolour.
const STRIP_BORDER = 28
const SIDE_PADDING = STRIP_BORDER
const TOP_PADDING = STRIP_BORDER
const PRE_FOOTER_GAP = STRIP_BORDER
// Unrelated to the photo border: how far the brand text sits from the
// footer's own edges (FOOTER_TEXT_INSET in photoStrip.ts).
const FOOTER_TEXT_INSET = STRIP_BORDER
const GAP = 10
const FOOTER_HEIGHT = 130
const BRAND_TEXT = 'NS Photobooth'
// One size for the QR and both logos, so all three match in width and
// height. Was QR 120 / logos 180, which rendered them visibly unequal.
const FOOTER_ICON_SIZE = 96
const QR_SIZE = FOOTER_ICON_SIZE
const QR_MARGIN = 16
const LOGO_SIZE = FOOTER_ICON_SIZE
const LOGO_GAP = 10
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

/** 11logo.png carries transparent padding inside the file (its opaque content
 * is ~880x798 of a 1152x1100 canvas) while fusionlogo.png has none. Drawing
 * both into the same box therefore renders the 11 logo visibly smaller.
 * Measure each logo's opaque bounds once, then draw only that region. */
const opaqueBoxCache = new WeakMap()

function opaqueBox(img) {
  const cached = opaqueBoxCache.get(img)
  if (cached) return cached
  const full = { x: 0, y: 0, w: img.width, h: img.height }
  let box = full
  try {
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const cx = c.getContext('2d')
    cx.drawImage(img, 0, 0)
    const { data } = cx.getImageData(0, 0, img.width, img.height)
    let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if (data[(y * img.width + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
      }
    }
    if (x1 >= x0 && y1 >= y0) box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
  } catch {
    // Fall back to the whole image if the canvas can't be read.
  }
  opaqueBoxCache.set(img, box)
  return box
}

/** Draw a logo's opaque content centred in a size x size box with its aspect
 * preserved, so both logos occupy the same footprint as each other and as
 * the QR code beside them. */
function drawFooterIcon(ctx, img, boxX, boxY, size) {
  const b = opaqueBox(img)
  const scale = Math.min(size / b.w, size / b.h)
  const w = b.w * scale
  const h = b.h * scale
  ctx.drawImage(img, b.x, b.y, b.w, b.h, boxX + (size - w) / 2, boxY + (size - h) / 2, w, h)
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
  ctx.font = 'italic 38px Georgia, serif'
  ctx.textBaseline = 'bottom'
  ctx.textAlign = 'left'
  ctx.fillText(
    `${BRAND_TEXT}   ${formatDateTime(timestamp)}`,
    FOOTER_TEXT_INSET,
    canvasHeight - FOOTER_TEXT_INSET,
  )

  const { x: qrX } = footerQrBox(canvasWidth, canvasHeight)
  const logoY = rowY - LOGO_SIZE / 2
  const fusionX = qrX - QR_MARGIN - LOGO_SIZE
  const logo11X = fusionX - LOGO_GAP - LOGO_SIZE

  const [logo11Img, fusionLogoImg] = await loadBrandLogos()
  drawFooterIcon(ctx, logo11Img, logo11X, logoY, LOGO_SIZE)
  drawFooterIcon(ctx, fusionLogoImg, fusionX, logoY, LOGO_SIZE)
}

async function createPhotoStrip(images, bgColor = '#ffffff', timestamp = Date.now()) {
  const loaded = await Promise.all(images.map(loadImage))
  const photoWidth = Math.max(...loaded.map((img) => img.width))
  const totalPhotoHeight = loaded.reduce((sum, img) => sum + img.height, 0)

  const canvas = document.createElement('canvas')
  canvas.width = photoWidth + SIDE_PADDING * 2
  canvas.height =
    totalPhotoHeight + GAP * (loaded.length - 1) + TOP_PADDING + PRE_FOOTER_GAP +
    FOOTER_HEIGHT

  const ctx = canvas.getContext('2d')
  ctx.fillStyle = bgColor
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  let y = TOP_PADDING
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

// ── Theme ──────────────────────────────────────────────────────────────────

/** Light/dark preference. Falls back to the OS setting the first time, so the
 * booth matches its surroundings before anyone touches the toggle; once a
 * choice is made it is remembered and the OS is no longer consulted. */
function useTheme() {
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved === 'light' || saved === 'dark') return saved
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))]
}

function ThemeToggle({ theme, onToggle, class: className }) {
  const dark = theme === 'dark'
  return (
    <button
      class={`theme-toggle${className ? ' ' + className : ''}`}
      onClick={onToggle}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      <span class="theme-toggle-icon">{dark ? '☀' : '☾'}</span>
      <span>{dark ? 'Light' : 'Dark'}</span>
    </button>
  )
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
      <div class="panel-card qr-box offline">
        <span class="qr-offline-dot" />
        <span>Saved offline — no QR</span>
      </div>
    )
  }

  return (
    <div class="panel-card qr-box">
      <canvas ref={canvasRef} />
      <p class="qr-label">Scan to download</p>
      <p class="qr-sublabel">Also printed on your strip</p>
    </div>
  )
}

// ── Color swatches ─────────────────────────────────────────────────────────

function ColorSwatches({ active, onChange, disabled }) {
  return (
    <div class="panel-card">
      <p class="panel-label">Background</p>
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
    </div>
  )
}

// ── Connect screen ─────────────────────────────────────────────────────────

function ConnectScreen({ defaultIp, connecting, error, onConnect, theme, onToggleTheme }) {
  const [ip, setIp] = useState(defaultIp)

  const handleConnect = () => {
    const trimmed = ip.trim()
    if (trimmed) onConnect(trimmed)
  }

  return (
    <div class="connect-screen">
      <ThemeToggle theme={theme} onToggle={onToggleTheme} class="connect-theme" />
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

/** Clock label under each thumbnail, so two similar-looking strips can be
 * told apart without opening both. */
function timeLabel(mtimeSec) {
  return new Date(mtimeSec * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function Thumbs({ photos, selected, ip, versions, onSelect }) {
  if (photos.length <= 1) return null
  return (
    <nav class="filmstrip" aria-label="Photos">
      {photos.map((p, i) => (
        <button
          key={p.filename}
          class={`thumb-btn${i === selected ? ' active' : ''}`}
          onClick={() => onSelect(i)}
          aria-current={i === selected}
        >
          <img
            class="thumb-img"
            src={photoUrl(ip, p.filename, versions[p.filename] ?? 0)}
            alt={p.filename}
          />
          <span class="thumb-time">{timeLabel(p.mtime)}</span>
        </button>
      ))}
    </nav>
  )
}

// ── Gallery screen ─────────────────────────────────────────────────────────

function GalleryScreen({
  photos, selected, ip, liveStatus, stripColors, versions,
  recoloring, onSelect, onDisconnect, onDelete, onColorChange, deleting,
  error, onDismissError, theme, onToggleTheme,
}) {
  const photo = photos[selected]
  const previewRef = useRef(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (!previewRef.current) return
    previewRef.current.style.animation = 'none'
    void previewRef.current.offsetWidth
    previewRef.current.style.animation = ''
  }, [selected, photo?.filename, versions[photo?.filename]])

  // Never carry a pending delete confirmation onto a different photo.
  useEffect(() => { setConfirmDelete(false) }, [selected, photo?.filename])

  // Arrow keys move through the filmstrip, so browsing doesn't require
  // aiming at small thumbnails.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowLeft') onSelect(Math.max(0, selected - 1))
      if (e.key === 'ArrowRight') onSelect(Math.min(photos.length - 1, selected + 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, photos.length, onSelect])

  return (
    <div class="gallery-screen">
      <header class="gallery-header">
        <button class="change-server-btn" onClick={onDisconnect}>← Change server</button>
        <div class="header-title">
          <h2>Your Photos</h2>
          {photos.length > 0 && (
            <span class="photo-count">{selected + 1} of {photos.length}</span>
          )}
        </div>
        <div class="header-right">
          <div class="live-badge">
            <span class={`live-dot ${liveStatus}`} />
            <span>{liveStatus === 'live' ? `Live · ${ip}` : 'Disconnected'}</span>
          </div>
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
      </header>

      {error && (
        <div class="error-banner" role="alert">
          <span>{error}</span>
          <button class="error-dismiss" onClick={onDismissError} aria-label="Dismiss">×</button>
        </div>
      )}

      {photos.length === 0 ? (
        <div class="state-msg">
          <p>No photos yet.</p>
          <small>Photos appear here after they are taken on the photobooth.</small>
        </div>
      ) : (
        <div class="gallery-body">
          <Thumbs photos={photos} selected={selected} ip={ip} versions={versions} onSelect={onSelect} />

          <div class="stage">
            <div class="photo-frame">
              {recoloring && <div class="recoloring-overlay">Updating colour…</div>}
              <img
                ref={previewRef}
                class="preview-img"
                src={photoUrl(ip, photo.filename, versions[photo.filename] ?? 0)}
                alt={photo.filename}
              />
            </div>
          </div>

          <aside class="side-panel">
            <QrBox url={photo.url} />

            <ColorSwatches
              active={stripColors[photo.filename] ?? STRIP_BG_OPTIONS[0]}
              onChange={(color) => onColorChange(photo, color)}
              disabled={recoloring}
            />

            <div class="panel-card">
              <p class="panel-label">Taken</p>
              <p class="capture-time">{new Date(photo.mtime * 1000).toLocaleString()}</p>
            </div>

            <div class="panel-card actions">
              <a
                class="btn btn-download"
                href={photoUrl(ip, photo.filename, versions[photo.filename] ?? 0)}
                download={photo.filename}
              >
                Download
              </a>

              {/* Two-step delete: the gallery is left running unattended and
                  this removes the file from the booth for every viewer. */}
              {confirmDelete ? (
                <div class="confirm-row">
                  <button
                    class="btn btn-delete"
                    onClick={() => { setConfirmDelete(false); onDelete() }}
                    disabled={deleting || recoloring}
                  >
                    {deleting ? '…' : 'Delete for good'}
                  </button>
                  <button class="btn btn-cancel" onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  class="btn btn-delete-outline"
                  onClick={() => setConfirmDelete(true)}
                  disabled={deleting || recoloring}
                >
                  Delete
                </button>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}

// ── Root app ───────────────────────────────────────────────────────────────

export function App() {
  const [theme, toggleTheme] = useTheme()
  const [serverIp, setServerIp] = useState(() => localStorage.getItem(STORAGE_KEY) ?? 'localhost')
  const [connected, setConnected] = useState(false)
  const [photos, setPhotos] = useState([])
  const [selected, setSelected] = useState(0)
  const [liveStatus, setLiveStatus] = useState('offline')
  const [connectError, setConnectError] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [recoloring, setRecoloring] = useState(false)
  // Surfaced as an inline banner instead of alert(): the gallery runs
  // unattended on a shared screen, where a modal browser dialog blocks the
  // whole app until someone walks over and dismisses it.
  const [error, setError] = useState('')
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
    setError('')
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
      setError('Delete failed: ' + e.message)
    } finally {
      setDeleting(false)
    }
  }

  async function handleColorChange(photo, color) {
    const current = stripColors[photo.filename] ?? STRIP_BG_OPTIONS[0]
    if (color === current || recoloring) return
    setRecoloring(true)
    setError('')
    try {
      // Fetch raw strip photos from backend
      const res = await fetch(
        `http://${serverIp}:${PORT}/photos/${encodeURIComponent(photo.filename)}/strips`,
        { signal: AbortSignal.timeout(15000) },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { stripPhotos } = await res.json()
      if (!stripPhotos || stripPhotos.length === 0) {
        setError('No original photos stored for recolouring. Take a new photo to enable this.')
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
      setError('Recolour failed: ' + e.message)
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
        theme={theme}
        onToggleTheme={toggleTheme}
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
      error={error}
      onDismissError={() => setError('')}
      theme={theme}
      onToggleTheme={toggleTheme}
    />
  )
}

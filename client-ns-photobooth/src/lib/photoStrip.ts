import QRCode from 'qrcode'
import logo11Url from '../assets/icons/11logo.png'
import fusionLogoUrl from '../assets/icons/fusionlogo.png'

/** Split an array into chunks of at most `size` elements each. */
export function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

// Loaded once and reused for every strip — both logos are static assets.
let brandLogosPromise: Promise<[HTMLImageElement, HTMLImageElement]> | null = null
function loadBrandLogos(): Promise<[HTMLImageElement, HTMLImageElement]> {
  if (!brandLogosPromise) {
    brandLogosPromise = Promise.all([loadImage(logo11Url), loadImage(fusionLogoUrl)])
  }
  return brandLogosPromise
}

export const DEFAULT_STRIP_BG = '#ffffff'
export const STRIP_BG_OPTIONS = [
  '#ffffff', // white
  '#f6dade', // blush pink
  '#dbe8dd', // sage green
  '#dbe4ef', // dusty blue
  '#f2ebe1', // cream
]

const PADDING = 24
const GAP = 10
const FOOTER_HEIGHT = 180
const BRAND_TEXT = 'NS Photobooth'
const QR_SIZE = 120
const QR_MARGIN = 20
const LOGO_SIZE = 90
const LOGO_GAP = 12

function formatDateTime(timestamp: number): string {
  const d = new Date(timestamp)
  const date = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(
    d.getDate(),
  ).padStart(2, '0')}/${d.getFullYear()}`
  let hours = d.getHours()
  const ampm = hours >= 12 ? 'PM' : 'AM'
  hours = hours % 12 || 12
  const minutes = String(d.getMinutes()).padStart(2, '0')
  return `${date}  ${hours}:${minutes} ${ampm}`
}

/** Shared layout so createPhotoStrip and addQrToStrip agree on QR placement. */
function footerQrBox(canvasWidth: number, canvasHeight: number) {
  const x = canvasWidth - QR_MARGIN - QR_SIZE
  const y = canvasHeight - FOOTER_HEIGHT / 2 - QR_SIZE / 2
  return { x, y, size: QR_SIZE }
}

async function drawFooter(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  timestamp: number,
) {
  const rowY = canvasHeight - FOOTER_HEIGHT / 2

  ctx.fillStyle = '#3f3a35'
  ctx.font = 'italic 20px Georgia, serif'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillText(`${BRAND_TEXT}   ${formatDateTime(timestamp)}`, PADDING, rowY)

  // Both logos sit beside the QR box, vertically centered on the same row
  // as the brand text/timestamp above.
  const { x: qrX } = footerQrBox(canvasWidth, canvasHeight)
  const logoY = rowY - LOGO_SIZE / 2
  const fusionX = qrX - QR_MARGIN - LOGO_SIZE
  const logo11X = fusionX - LOGO_GAP - LOGO_SIZE

  const [logo11Img, fusionLogoImg] = await loadBrandLogos()
  ctx.drawImage(logo11Img, logo11X, logoY, LOGO_SIZE, LOGO_SIZE)
  ctx.drawImage(fusionLogoImg, fusionX, logoY, LOGO_SIZE, LOGO_SIZE)
}

/** Stack photos vertically into a single strip image (data URL), on a
 * solid colored background with a reserved footer for a brand label + QR.
 * Pass the same `images`/`timestamp` with a different `bgColor` to re-theme
 * a strip — a full redraw, so it always starts from a clean (QR-free) base. */
export async function createPhotoStrip(
  images: string[],
  bgColor: string = DEFAULT_STRIP_BG,
  timestamp: number = Date.now(),
): Promise<string> {
  const loaded = await Promise.all(images.map(loadImage))

  const photoWidth = Math.max(...loaded.map((img) => img.width))
  const totalPhotoHeight = loaded.reduce((sum, img) => sum + img.height, 0)

  const canvas = document.createElement('canvas')
  canvas.width = photoWidth + PADDING * 2
  canvas.height =
    totalPhotoHeight + GAP * (loaded.length - 1) + PADDING * 2 + FOOTER_HEIGHT

  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = bgColor
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  let y = PADDING
  for (const img of loaded) {
    const x = (canvas.width - img.width) / 2
    ctx.drawImage(img, x, y)
    y += img.height + GAP
  }

  await drawFooter(ctx, canvas.width, canvas.height, timestamp)

  return canvas.toDataURL(
    import.meta.env.VITE_IMG_UPLOAD_FORMAT,
    parseFloat(import.meta.env.VITE_IMG_UPLOAD_QUALITY),
  )
}

/** Redraw an already-composited (QR-free) strip with a scannable QR code
 * baked into the reserved footer — called once the photo's share URL is
 * known, i.e. after upload. */
export async function addQrToStrip(
  stripDataUrl: string,
  qrValue: string,
): Promise<string> {
  const strip = await loadImage(stripDataUrl)

  const canvas = document.createElement('canvas')
  canvas.width = strip.width
  canvas.height = strip.height
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(strip, 0, 0)

  const { x, y, size } = footerQrBox(canvas.width, canvas.height)
  const qrPadding = 8
  ctx.fillStyle = 'white'
  ctx.fillRect(
    x - qrPadding,
    y - qrPadding,
    size + qrPadding * 2,
    size + qrPadding * 2,
  )

  const qrDataUrl = await QRCode.toDataURL(qrValue, { margin: 0, width: size })
  const qrImg = await loadImage(qrDataUrl)
  ctx.drawImage(qrImg, x, y, size, size)

  return canvas.toDataURL(
    import.meta.env.VITE_IMG_UPLOAD_FORMAT,
    parseFloat(import.meta.env.VITE_IMG_UPLOAD_QUALITY),
  )
}

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
const FOOTER_HEIGHT = 230
const BRAND_TEXT = 'NS Photobooth'
// QR code and both logos are all the same visual size in the footer.
const FOOTER_ICON_SIZE = 150
const QR_MARGIN = 20
const LOGO_GAP = 12
const FONT_SIZE = 50
// A single photo makes a much shorter strip overall, so the same
// fixed-height footer sized for a 3-photo strip looks oversized/
// disproportionate — scale the whole footer band down for single images.
const SINGLE_IMAGE_FOOTER_SCALE = 0.5

/** Footer dimensions, scaled down for a single-photo strip so the bottom
 * border doesn't dominate a much shorter image. */
function footerMetrics(imageCount: number) {
  const scale = imageCount === 1 ? SINGLE_IMAGE_FOOTER_SCALE : 1
  return {
    height: FOOTER_HEIGHT * scale,
    qrSize: FOOTER_ICON_SIZE * scale,
    qrMargin: QR_MARGIN * scale,
    logoSize: FOOTER_ICON_SIZE * scale,
    logoGap: LOGO_GAP * scale,
    fontSize: FONT_SIZE * scale,
  }
}

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

/** Shared layout so createPhotoStrip and addQrToStrip agree on QR placement.
 * imageCount must match what the strip was originally built with (1 vs
 * more), since that's what determines the footer's scale. */
function footerQrBox(canvasWidth: number, canvasHeight: number, imageCount: number) {
  const { height, qrSize, qrMargin } = footerMetrics(imageCount)
  const x = canvasWidth - qrMargin - qrSize
  const y = canvasHeight - height / 2 - qrSize / 2
  return { x, y, size: qrSize }
}

async function drawFooter(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  timestamp: number,
  imageCount: number,
) {
  const { height, qrMargin, logoSize, logoGap, fontSize } = footerMetrics(imageCount)
  const rowY = canvasHeight - height / 2

  ctx.fillStyle = '#3f3a35'
  ctx.font = `italic ${fontSize}px Georgia, serif`
  ctx.textBaseline = 'bottom'
  ctx.textAlign = 'left'
  ctx.fillText(
    `${BRAND_TEXT}   ${formatDateTime(timestamp)}`,
    PADDING,
    canvasHeight - PADDING,
  )

  // Both logos sit beside the QR box, vertically centered on the same row
  // as the brand text/timestamp above.
  const { x: qrX } = footerQrBox(canvasWidth, canvasHeight, imageCount)
  const logoY = rowY - logoSize / 2
  const fusionX = qrX - qrMargin - logoSize
  const logo11X = fusionX - logoGap - logoSize

  const [logo11Img, fusionLogoImg] = await loadBrandLogos()
  ctx.drawImage(logo11Img, logo11X, logoY, logoSize, logoSize)
  ctx.drawImage(fusionLogoImg, fusionX, logoY, logoSize, logoSize)
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
    totalPhotoHeight + GAP * (loaded.length - 1) + PADDING * 2 +
    footerMetrics(loaded.length).height

  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = bgColor
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  let y = PADDING
  for (const img of loaded) {
    const x = (canvas.width - img.width) / 2
    ctx.drawImage(img, x, y)
    y += img.height + GAP
  }

  await drawFooter(ctx, canvas.width, canvas.height, timestamp, loaded.length)

  return canvas.toDataURL(
    import.meta.env.VITE_IMG_UPLOAD_FORMAT,
    parseFloat(import.meta.env.VITE_IMG_UPLOAD_QUALITY),
  )
}

/** Redraw an already-composited (QR-free) strip with a scannable QR code
 * baked into the reserved footer — called once the photo's share URL is
 * known, i.e. after upload. `imageCount` must match what the strip was
 * originally built with (createPhotoStrip's `images.length`), since that's
 * what determines the footer's scale and therefore the QR's position. */
export async function addQrToStrip(
  stripDataUrl: string,
  qrValue: string,
  imageCount: number = 2,
): Promise<string> {
  const strip = await loadImage(stripDataUrl)

  const canvas = document.createElement('canvas')
  canvas.width = strip.width
  canvas.height = strip.height
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(strip, 0, 0)

  const { x, y, size } = footerQrBox(canvas.width, canvas.height, imageCount)
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

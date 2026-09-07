import QRCode from 'qrcode'
import logo11Url from '../assets/icons/11logo.png'
import fusionLogoUrl from '../assets/icons/fusionlogo.png'
import atlasLogoUrl from '../assets/icons/Atlas Logo.jpeg'
import boreasLogoUrl from '../assets/icons/Boreas Logo.jpeg'
import hqLogoUrl from '../assets/icons/HQ Logo.jpeg'
import rstaLogoUrl from '../assets/icons/RSTA Logo.jpeg'
import signalLogoUrl from '../assets/icons/Signal Logo.jpeg'
import { CoyLogo, selectedCoyLogo } from '../store'

/** Company logo files, keyed to match COY_LOGOS in the store. 'none' has no
 * entry: the footer skips the slot entirely rather than drawing a blank. */
const COY_LOGO_URLS: Partial<Record<CoyLogo, string>> = {
  '11': logo11Url,
  atlas: atlasLogoUrl,
  boreas: boreasLogoUrl,
  hq: hqLogoUrl,
  rsta: rstaLogoUrl,
  signal: signalLogoUrl,
}

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

// fusionlogo is on every strip, so it is loaded once and kept.
let fusionLogoPromise: Promise<HTMLImageElement> | null = null
function loadFusionLogo(): Promise<HTMLImageElement> {
  if (!fusionLogoPromise) fusionLogoPromise = loadImage(fusionLogoUrl)
  return fusionLogoPromise
}

// The company logo can change between strips, so it is cached per key rather
// than once globally - switching in Settings and taking another photo must not
// keep drawing the previous company's logo.
const coyLogoPromises = new Map<CoyLogo, Promise<HTMLImageElement>>()
function loadCoyLogo(key: CoyLogo): Promise<HTMLImageElement> | null {
  const url = COY_LOGO_URLS[key]
  if (!url) return null
  let p = coyLogoPromises.get(key)
  if (!p) {
    p = loadImage(url)
    coyLogoPromises.set(key, p)
  }
  return p
}

export const DEFAULT_STRIP_BG = '#ffffff'

// The strip's background colour (the one the swatches change) shows as a
// border on all four sides, not just under the photos. STRIP_BORDER is that
// band's thickness — roughly an eighth of the old 230px footer — and is
// reused for the gap above the footer so the inset is even all the way
// round. FOOTER_TEXT_INSET matches it so the brand text lines up with the
// photo edge above it.
const STRIP_BORDER = 28
const SIDE_PADDING = STRIP_BORDER
const TOP_PADDING = STRIP_BORDER
const PRE_FOOTER_GAP = STRIP_BORDER
const FOOTER_TEXT_INSET = STRIP_BORDER
const GAP = 10
// Was 230, which dwarfed the photos above it. The footer only has to hold
// one row of icons plus a line of text, so it is sized off the icons now.
const FOOTER_HEIGHT = 130
const BRAND_TEXT = 'NS Photobooth'
// QR code and both logos are all drawn into the same square box, so they
// come out the same width and the same height as each other.
const FOOTER_ICON_SIZE = 96
const QR_MARGIN = 16
const LOGO_GAP = 10
const FONT_SIZE = 38
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

/** Logos carry padding inside the file, and not the same kind. 11logo.png's
 * opaque content is ~880x798 of a 1152x1100 canvas while fusionlogo.png has
 * none, so drawing both into the same box renders the 11 logo visibly
 * smaller. Measure each logo's content bounds once and draw only that region.
 *
 * "Content" means two different things depending on the file. The two brand
 * PNGs are transparent, so their padding is alpha. The company logos are
 * opaque JPEGs on white, so alpha finds nothing and the whole square measures
 * as content - which would render them noticeably larger and boxier than
 * fusionlogo beside them. For those, near-white is treated as padding too.
 *
 * Only the OUTER margin is trimmed either way, so white inside a logo is
 * kept; nothing is made transparent. A company logo therefore still draws its
 * own white background, which is invisible on the default white strip and
 * shows as a pale block on a coloured one. Supplying those logos as PNGs with
 * real transparency is the fix if coloured strips are used. */
const opaqueBoxCache = new WeakMap<HTMLImageElement, { x: number; y: number; w: number; h: number }>()

function opaqueBox(img: HTMLImageElement) {
  const cached = opaqueBoxCache.get(img)
  if (cached) return cached
  const full = { x: 0, y: 0, w: img.width, h: img.height }
  let box = full
  try {
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const cx = c.getContext('2d')!
    cx.drawImage(img, 0, 0)
    const { data } = cx.getImageData(0, 0, img.width, img.height)

    // Does this image use alpha at all? Sampling the four corners is enough:
    // padding lives at the edges, so a file with transparent padding has
    // transparent corners. If none are transparent the file is opaque and
    // near-white has to stand in for padding instead.
    const cornerAlpha = [
      data[3],
      data[(img.width - 1) * 4 + 3],
      data[((img.height - 1) * img.width) * 4 + 3],
      data[((img.height - 1) * img.width + img.width - 1) * 4 + 3],
    ]
    const usesAlpha = cornerAlpha.some((a) => a <= 8)
    // Generous enough to catch JPEG compression noise around the edges of a
    // white background, tight enough not to eat pale content.
    const WHITE = 244

    let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4
        const isContent = usesAlpha
          ? data[i + 3] > 8
          : data[i] < WHITE || data[i + 1] < WHITE || data[i + 2] < WHITE
        if (isContent) {
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
function drawFooterIcon(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  boxX: number,
  boxY: number,
  size: number,
) {
  const b = opaqueBox(img)
  const scale = Math.min(size / b.w, size / b.h)
  const w = b.w * scale
  const h = b.h * scale
  ctx.drawImage(img, b.x, b.y, b.w, b.h, boxX + (size - w) / 2, boxY + (size - h) / 2, w, h)
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
    FOOTER_TEXT_INSET,
    canvasHeight,
  )

  // Logos sit beside the QR box, vertically centered on the same row as the
  // brand text/timestamp above. The company logo is read at draw time rather
  // than passed in, so a strip re-themed later (addQrToStrip redraws from
  // scratch) picks up the current selection like every other strip does.
  const { x: qrX } = footerQrBox(canvasWidth, canvasHeight, imageCount)
  const logoY = rowY - logoSize / 2
  const fusionX = qrX - qrMargin - logoSize
  const coyX = fusionX - logoGap - logoSize

  const fusionLogoImg = await loadFusionLogo()
  drawFooterIcon(ctx, fusionLogoImg, fusionX, logoY, logoSize)

  // 'none' draws nothing and leaves the slot empty rather than shifting the
  // other icons: fusionlogo and the QR keep their positions, so strips with
  // and without a company logo still line up with each other.
  const coyPromise = loadCoyLogo(selectedCoyLogo.get())
  if (coyPromise) drawFooterIcon(ctx, await coyPromise, coyX, logoY, logoSize)
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
  canvas.width = photoWidth + SIDE_PADDING * 2
  canvas.height =
    totalPhotoHeight + GAP * (loaded.length - 1) + TOP_PADDING + PRE_FOOTER_GAP +
    footerMetrics(loaded.length).height

  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = bgColor
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  let y = TOP_PADDING
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

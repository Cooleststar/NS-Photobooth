import QRCode from 'qrcode'
import { contentBox } from './imageBounds'
import { LOGO_URLS, LogoKey } from './logos'
import { COY_LOGOS, CoyLogo, selectedCoyLogo } from '../store'

const logo11Url = LOGO_URLS['11']

// Fixed draw order (same list Settings/TopControls show), independent of the
// order logos were clicked in - so toggling one off and back on doesn't
// reshuffle the row. 'none' is filtered out: it has no file in LOGO_URLS,
// and is never itself a member of a selection - see COY_LOGOS in store.ts.
const COY_ORDER = (Object.keys(COY_LOGOS) as CoyLogo[])
  .filter((k): k is Exclude<CoyLogo, 'none'> => k in LOGO_URLS)

/** The middle slot's files, in fixed draw order - empty for no selection,
 * which draws nothing rather than a blank. 11logo is never selectable here:
 * it is the fixed slot. */
function coyLogoUrls(keys: readonly CoyLogo[]): LogoKey[] {
  return COY_ORDER.filter((k) => keys.includes(k))
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

// 11logo is on every strip, so it is loaded once and kept.
let logo11Promise: Promise<HTMLImageElement> | null = null
function loadLogo11(): Promise<HTMLImageElement> {
  if (!logo11Promise) logo11Promise = loadImage(logo11Url)
  return logo11Promise
}

// The middle slot's selection can change between strips, so each logo is
// cached per key rather than once globally - switching in Settings and
// taking another photo must not keep drawing a stale selection.
const coyLogoPromises = new Map<LogoKey, Promise<HTMLImageElement>>()
function loadCoyLogo(key: LogoKey): Promise<HTMLImageElement> {
  let p = coyLogoPromises.get(key)
  if (!p) {
    p = loadImage(LOGO_URLS[key])
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

/** Draw a logo's opaque content centred in a size x size box with its aspect
 * preserved, so both logos occupy the same footprint as each other and as
 * the QR code beside them.
 *
 * Uses contentBox (lib/imageBounds.ts) rather than the raw image dimensions:
 * logos carry different amounts of padding inside their own file - 11logo.png
 * has real padding, fusionlogo.png has none - so drawing both into the same
 * box by raw dimensions renders the 11 logo visibly smaller. */
function drawFooterIcon(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  boxX: number,
  boxY: number,
  size: number,
) {
  const b = contentBox(img)
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

  // Footer row is [11logo] [selectable, side by side] [QR], vertically
  // centered on the same row as the brand text/timestamp above. 11logo is
  // fixed; the middle slot holds zero or more company logos, and that block
  // grows outward as more are selected (each logo keeps logoSize; the block
  // gets wider) rather than shrinking to fit a fixed footprint - same choice
  // as the banner logo row, see anim/banner.ts. 11logo sits immediately to
  // its left, and the QR stays fixed on the right regardless of count.
  //
  // The selection is read at draw time rather than passed in, so a strip
  // re-themed later (addQrToStrip redraws from scratch) picks up the current
  // choice like every other strip does.
  const { x: qrX } = footerQrBox(canvasWidth, canvasHeight, imageCount)
  const logoY = rowY - logoSize / 2

  const coyKeys = coyLogoUrls(selectedCoyLogo.get())
  const middleWidth = coyKeys.length
    ? coyKeys.length * logoSize + (coyKeys.length - 1) * logoGap
    : 0
  const middleLeftEdge = qrX - qrMargin - middleWidth
  const logo11X = middleLeftEdge - (coyKeys.length ? logoGap : 0) - logoSize

  drawFooterIcon(ctx, await loadLogo11(), logo11X, logoY, logoSize)

  let x = middleLeftEdge
  for (const key of coyKeys) {
    drawFooterIcon(ctx, await loadCoyLogo(key), x, logoY, logoSize)
    x += logoSize + logoGap
  }
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

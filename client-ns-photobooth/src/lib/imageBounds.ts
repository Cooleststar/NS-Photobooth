/** Measures an image's opaque/non-transparent content bounds, trimming outer
 * padding.
 *
 * Different logo files carry different amounts of padding inside their own
 * canvas - 11logo.png's opaque content is ~880x798 of a 1152x1100 canvas
 * while fusionlogo.png has none - so scaling two logos by the same
 * dimension (or drawing both into the same size box) renders one visibly
 * smaller than the other even though the numbers match exactly. Measuring
 * the real content and scaling/cropping from THAT instead is what makes a
 * mixed set of logos read as the same size as each other.
 *
 * Shared by lib/photoStrip.ts (draws onto a 2D canvas) and anim/banner.ts
 * (crops a PIXI texture) - same measurement, two different consumers. */

export interface ImageBox {
  x: number
  y: number
  w: number
  h: number
}

// Keyed by source element, not URL: photoStrip.ts and banner.ts each load
// their own independent HTMLImageElement for the same logo (a plain <img>
// there, PIXI's loader here), so there is no shared element to key on
// across the two - each file gets this cache "for free" on repeat calls
// with its own element instead.
const cache = new WeakMap<HTMLImageElement | HTMLCanvasElement, ImageBox>()

export function contentBox(source: HTMLImageElement | HTMLCanvasElement): ImageBox {
  const cached = cache.get(source)
  if (cached) return cached

  const width = source.width
  const height = source.height
  const full = { x: 0, y: 0, w: width, h: height }
  let box = full
  try {
    const c = document.createElement('canvas')
    c.width = width
    c.height = height
    const cx = c.getContext('2d')!
    cx.drawImage(source, 0, 0)
    const { data } = cx.getImageData(0, 0, width, height)

    // Does this image use alpha at all? Sampling the four corners is enough:
    // padding lives at the edges, so a file with transparent padding has
    // transparent corners. If none are transparent the file is opaque and
    // near-white has to stand in for padding instead.
    const cornerAlpha = [
      data[3],
      data[(width - 1) * 4 + 3],
      data[((height - 1) * width) * 4 + 3],
      data[((height - 1) * width + width - 1) * 4 + 3],
    ]
    const usesAlpha = cornerAlpha.some((a) => a <= 8)
    // Generous enough to catch JPEG compression noise around the edges of a
    // white background, tight enough not to eat pale content.
    const WHITE = 244

    let x0 = width, y0 = height, x1 = -1, y1 = -1
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
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
  cache.set(source, box)
  return box
}

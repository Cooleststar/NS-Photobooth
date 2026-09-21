import * as PIXI from '../pixi'

import { contentBox } from '../lib/imageBounds'
import { LOGO_URLS, LogoKey } from '../lib/logos'
import { BANNER_LOGO_ORDER, selectedBannerLogo } from '../store'

// Where the logo row sits over the live feed, measured from the original
// artwork. border_design6.png (and banner_frame.png, its now-removed
// decorative-frame companion) had the 11 crest painted in at x 866..1050,
// y 895..1027 of a 1920x1080 canvas, so reproducing these fractions puts a
// single selected logo exactly where the baked one used to be - with more
// than one selected, the row is centred on that same point instead.
const LOGO_CENTER_X = 0.499
const LOGO_CENTER_Y = 0.890
// The pixel target every logo is sized to fit, as a fraction of canvas
// WIDTH (same reference the row's other fractions below use - canvas width
// is the stable one across the 16:9 resolutions this booth runs at). What
// changed is which axis that target pins: it now sets each logo's HEIGHT,
// not its width, with width following from its own aspect ratio - see
// layout() below. Logo files differ both in padding (11logo.png carries
// real padding, fusionlogo.png has none) and in native aspect ratio (Signal
// Logo.png is a short wide banner, ~500x374, next to the others' roughly
// square ~500x500), so matching width does NOT mean matching apparent size,
// which is the whole point of this row. Each logo's texture is cropped to
// its actual content first (see contentBox below), removing the padding
// difference; pinning height on what's left is what then guarantees every
// logo reads at the same height as the rest, however wide or narrow its own
// artwork happens to be.
const LOGO_SIZE_FRACTION = 0.096
// Each logo keeps this same height regardless of how many are on screen at
// once, and the row's total width just follows from that - it grows outward
// from LOGO_CENTER_X rather than shrinking logos to fit a fixed footprint.
const LOGO_GAP_FRACTION = 0.016

// Fixed draw order (same list Settings/TopControls show), independent of the
// order logos were clicked in - so toggling one off and back on doesn't
// reshuffle the row. See BANNER_LOGO_ORDER in store.ts for why this isn't
// just Object.keys(BANNER_LOGOS).
const ORDER = BANNER_LOGO_ORDER.filter((k): k is LogoKey => k in LOGO_URLS)

/** One or more selectable logos shown over the live feed and included in
 * every photo taken.
 *
 * Used to also draw a decorative frame around the feed (a separate
 * container, hidden during capture since photos get their own border
 * treatment in the gallery) — removed on request as a redundant/pointless
 * toggle once the logo already had its own on/off control. Only the logo
 * row remains now. */
export async function createBanner(app: PIXI.Application) {
  const {
    renderer: { width, height },
    loader,
  } = app

  const logoContainer = new PIXI.Container()
  // One sprite per selected logo, keyed by its LogoKey, reused across
  // re-applies so an unchanged selection doesn't reload/reposition anything.
  const sprites = new Map<LogoKey, PIXI.Sprite>()

  const layout = () => {
    const heightPx = width * LOGO_SIZE_FRACTION
    const gapPx = width * LOGO_GAP_FRACTION
    const ordered = ORDER.filter((k) => sprites.has(k))
    // '11' is the default/fixed logo, so it reads as the row's anchor rather
    // than just another entry — pull it out of its slot in ORDER and
    // reinsert it at the middle index instead. For an even count this lands
    // one left of true centre (e.g. 2nd of 4) rather than splitting it
    // between two positions, matching how a single centred item naturally
    // shifts as neighbours are added one at a time.
    const elevenIndex = ordered.indexOf('11')
    if (elevenIndex !== -1) {
      const [eleven] = ordered.splice(elevenIndex, 1)
      ordered.splice(Math.floor(ordered.length / 2), 0, eleven)
    }
    // Each sprite's own (already-cropped) texture aspect ratio decides its
    // width - see applyLogos below - so widths vary per logo even though
    // every one is sized to the same height.
    const widths = ordered.map((key) => {
      const tex = sprites.get(key)!.texture
      return heightPx * (tex.width / tex.height)
    })
    const totalWidth = widths.reduce((a, b) => a + b, 0) + Math.max(0, ordered.length - 1) * gapPx
    let x = width * LOGO_CENTER_X - totalWidth / 2
    ordered.forEach((key, i) => {
      const sprite = sprites.get(key)!
      const widthPx = widths[i]
      sprite.height = heightPx
      sprite.width = widthPx
      sprite.position.set(x + widthPx / 2, height * LOGO_CENTER_Y)
      x += widthPx + gapPx
    })
  }

  // Reloading on every change rather than preloading all seven: the
  // selection changes in Settings between sessions, not per-frame, and
  // PIXI's loader caches each texture after its first use anyway.
  let applyToken = 0
  const applyLogos = async () => {
    const token = ++applyToken
    const keys = selectedBannerLogo.get().filter((k): k is LogoKey => k in LOGO_URLS)

    // Drop sprites for logos no longer selected.
    for (const [key, sprite] of sprites) {
      if (!keys.includes(key)) {
        logoContainer.removeChild(sprite)
        sprite.destroy()
        sprites.delete(key)
      }
    }

    // Add sprites for newly selected logos.
    for (const key of keys) {
      if (sprites.has(key)) continue
      const { texture: logoTex } = await PIXI.ensureLoaded(loader, LOGO_URLS[key]!)
      // A slower load can finish after the user has changed the selection
      // again - drop it rather than adding a stale sprite.
      if (token !== applyToken) return
      if (!selectedBannerLogo.get().includes(key)) continue

      // Crop to the logo's actual content, trimming whatever padding its
      // own file happens to carry - a fresh Texture wrapping the same
      // baseTexture rather than mutating logoTex.frame directly, since
      // logoTex is the shared, cached texture PIXI.ensureLoaded hands back
      // for this URL (see textureCache in store.ts) and mutating it would
      // affect every other consumer of the same logo.
      let tex = logoTex!
      const resource = tex.baseTexture.resource
      if (resource instanceof PIXI.BaseImageResource) {
        const source = resource.source
        if (source instanceof HTMLImageElement || source instanceof HTMLCanvasElement) {
          const box = contentBox(source)
          if (box.w > 0 && box.h > 0) {
            tex = new PIXI.Texture(tex.baseTexture, new PIXI.Rectangle(box.x, box.y, box.w, box.h))
          }
        }
      }

      const sprite = new PIXI.Sprite(tex)
      sprite.anchor.set(0.5, 0.5)
      sprites.set(key, sprite)
      logoContainer.addChild(sprite)
    }

    layout()
  }

  await applyLogos()
  const unsubscribe = selectedBannerLogo.subscribe(() => void applyLogos())

  return { logoContainer, unsubscribe }
}

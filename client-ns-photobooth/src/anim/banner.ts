import * as PIXI from '../pixi'

import { LOGO_URLS } from '../lib/logos'
import { selectedBannerLogo } from '../store'

// Where the logo sits over the live feed, measured from the original
// artwork. border_design6.png (and banner_frame.png, its now-removed
// decorative-frame companion) had the 11 crest painted in at x 866..1050,
// y 895..1027 of a 1920x1080 canvas, so reproducing these fractions puts a
// selected logo exactly where the baked one used to be.
const LOGO_CENTER_X = 0.499
const LOGO_CENTER_Y = 0.890
const LOGO_WIDTH_FRACTION = 0.096

/** A selectable logo shown over the live feed and included in every photo
 * taken.
 *
 * Used to also draw a decorative frame around the feed (a separate
 * container, hidden during capture since photos get their own border
 * treatment in the gallery) — removed on request as a redundant/pointless
 * toggle once the logo already had its own on/off control. Only the logo
 * remains now. */
export async function createBanner(app: PIXI.Application) {
  const {
    renderer: { width, height },
    loader,
  } = app

  const logoContainer = new PIXI.Container()
  const logoSprite = new PIXI.Sprite()
  logoSprite.anchor.set(0.5, 0.5)
  logoSprite.position.set(width * LOGO_CENTER_X, height * LOGO_CENTER_Y)
  logoContainer.addChild(logoSprite)

  // Reloading on every change rather than preloading all seven: only one is on
  // screen at a time, the switch happens in Settings between sessions, and
  // PIXI's loader caches each texture after its first use anyway.
  let applied: string | null = null
  const applyLogo = async () => {
    const key = selectedBannerLogo.get()
    if (key === applied) return
    applied = key
    if (key === 'none') {
      logoSprite.visible = false
      return
    }
    const url = LOGO_URLS[key]
    if (!url) {
      logoSprite.visible = false
      return
    }
    const { texture: logoTex } = await PIXI.ensureLoaded(loader, url)
    // A slower load can finish after the user has picked something else -
    // drop it rather than overwriting the newer choice.
    if (applied !== key) return
    logoSprite.texture = logoTex!
    logoSprite.width = width * LOGO_WIDTH_FRACTION
    logoSprite.height = logoSprite.width * (logoTex!.height / logoTex!.width)
    logoSprite.visible = true
  }

  await applyLogo()
  const unsubscribe = selectedBannerLogo.subscribe(() => void applyLogo())

  return { logoContainer, unsubscribe }
}

import * as PIXI from '../pixi'

import bannerImg from '../assets/borders/banner_frame.png'
import { LOGO_URLS } from '../lib/logos'
import { selectedBannerLogo } from '../store'

// Where the logo sits within the banner, measured from the original artwork.
// border_design6.png had the 11 crest painted into it at x 866..1050,
// y 895..1027 of a 1920x1080 canvas; banner_frame.png is that same file with
// the crest removed, so reproducing these fractions puts a selected logo
// exactly where the baked one used to be.
const LOGO_CENTER_X = 0.499
const LOGO_CENTER_Y = 0.890
const LOGO_WIDTH_FRACTION = 0.096

/** The decorative frame over the live feed, plus a selectable logo.
 *
 * Returned as two containers on purpose. Display.tsx hides the frame during
 * capture (photos get their own border treatment in the gallery) but keeps the
 * logo visible, which is what puts the logo into every photo taken - the whole
 * thing used to hide together, so the baked-in logo never appeared in one.
 */
export async function createBanner(app: PIXI.Application) {
  const {
    renderer: { width, height },
    loader,
  } = app

  const frameContainer = new PIXI.Container()
  const { texture } = await PIXI.ensureLoaded(loader, bannerImg)
  const borderSprite = PIXI.Sprite.from(texture!)
  borderSprite.scale.set(width / borderSprite.width)
  frameContainer.addChild(borderSprite)

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

  return { frameContainer, logoContainer, unsubscribe }
}

import * as PIXI from '../pixi'

import bannerImg from '../assets/borders/border_design4.png'

export async function createBanner(app: PIXI.Application) {
  const {
    renderer: { width },
    loader,
  } = app
  const bannerContainer = new PIXI.Container()
  const { texture } = await PIXI.ensureLoaded(loader, bannerImg)

  const borderSprite = PIXI.Sprite.from(texture!)
  borderSprite.scale.set(width / borderSprite.width)
  bannerContainer.addChild(borderSprite)

  return bannerContainer
}

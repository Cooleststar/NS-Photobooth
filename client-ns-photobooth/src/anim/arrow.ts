import * as PIXI from '../pixi'
import { NormalizedLandmarkList } from '@mediapipe/drawing_utils'

import { createKFilter } from './utils'
import { convertPoint } from '../api/nicepipe/mpPose'
import arrowImg from '../assets/arrow-down.png'

const KF_PARAMS = { R: 0.02, Q: 5 }

/** animation to indicate current target */
export async function createArrowPointer(app: PIXI.Application) {
  const {
    renderer: { height, width },
    loader,
  } = app
  const arrowContainer = new PIXI.Container()
  const { texture } = await PIXI.ensureLoaded(loader, arrowImg)

  const arrowSprite = PIXI.Sprite.from(texture!)
  arrowSprite.alpha = 0
  arrowSprite.anchor.set(0.5, 1)
  arrowContainer.addChild(arrowSprite)

  const kfilter = createKFilter(KF_PARAMS)

  let [x, y, size] = [0, 0, 200]
  const update = (pose: NormalizedLandmarkList) => {
    // Determining animation state
    if (pose.length == 0) return (arrowSprite.alpha = 0)
    const nose = convertPoint(pose[0], height, width)

    ;({ x, y, size } = kfilter({
      x: nose.x,
      y: nose.y,
      size: Math.abs(pose[8].x - pose[7].x),
    }))

    arrowSprite.width = arrowSprite.height = size * width
    arrowSprite.alpha = 1
    arrowSprite.position.set(x, y - arrowSprite.height)
  }

  return [arrowContainer, update] as const
}

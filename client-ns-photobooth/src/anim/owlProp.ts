import * as PIXI from '../pixi'

import { CommonAnimOpts, defaultAnimOpts } from '.'
import { lerpLinear, lerpEO, createKFilter } from './utils'
import { LocationTarget } from '.'
import { AnimStateManager } from './AnimState'

import owlIdleGif from '../assets/owl_anim/owl_idle_new.gif'
import owlFlyGif from '../assets/owl_anim/owl_flying_new.gif'
import owlLandGif from '../assets/owl_anim/owl_landing_new.gif'

export interface OwlPropOpts extends CommonAnimOpts {
  /** Number of flight loops */
  numFlyLoops?: number
  /** Where owl will fly in from */
  origin?: [number, number]
}

export const defaultOwlPropOpts: Readonly<Required<OwlPropOpts>> = {
  ...defaultAnimOpts,
  numFlyLoops: parseFloat(import.meta.env.VITE_ANIM_OWL_FLY_LOOPS),
  origin: [1, 0],
}

export async function createOwlPropAnim(
  app: PIXI.Application,
  opts?: OwlPropOpts,
) {
  const {
    renderer: { height, width },
    ticker,
    loader,
  } = app

  const {
    durationFade,
    durationRetrack,
    kalman,
    sizeFactor,
    xOffset,
    yOffset,
    flip,
    origin,
    numFlyLoops,
  } = { ...defaultOwlPropOpts, ...opts }

  const owlContainer = new PIXI.Container()
  if (flip) owlContainer.scale.x = -1

  const oriX = origin[0] * width
  const oriY = origin[1] * height

  // cloning necessary for reuse since animation itself is a single sprite...
  const [idleSprite, flySprite, landSprite] = await Promise.all([
    PIXI.ensureLoaded(loader, owlIdleGif).then((res) => res.animation!.clone()),
    PIXI.ensureLoaded(loader, owlFlyGif).then((res) => res.animation!.clone()),
    PIXI.ensureLoaded(loader, owlLandGif).then((res) => res.animation!.clone()),
  ])

  idleSprite.anchor.set(0.5, 0.5)
  owlContainer.addChild(idleSprite)
  flySprite.anchor.set(0.5, 0.5)
  owlContainer.addChild(flySprite)
  landSprite.anchor.set(0.5, 0.5)
  owlContainer.addChild(landSprite)

  const initialState = () => {
    owlContainer.alpha = 1
    owlContainer.position.set(oriX, oriY)
    idleSprite.stop()
    flySprite.stop()
    landSprite.stop()
    idleSprite.alpha = flySprite.alpha = landSprite.alpha = 0
    idleSprite.currentFrame =
      flySprite.currentFrame =
      landSprite.currentFrame =
        0
  }
  initialState()

  // NOTE: last fly loop included in landing animation
  /** time in seconds till land animation */
  const toLandTime = (flySprite.duration * numFlyLoops) / 1000
  /** time in seconds till idle animation */
  const toIdleTime = toLandTime + landSprite.duration / 1000
  /** time in seconds since start of animation */
  const kfilter = createKFilter(kalman)
  const animManager = new AnimStateManager()

  let [x, y, size, angle] = [oriX, oriY, 500, 0]
  const update = (tgt?: LocationTarget) => {
    if (tgt) {
      ;({ x, y, size, angle } = kfilter(tgt))
      size *= sizeFactor
      x += xOffset * size
      y += yOffset * size
    }

    idleSprite.angle = angle
    idleSprite.height =
      idleSprite.width =
      flySprite.height =
      flySprite.width =
      landSprite.height =
      landSprite.width =
        size

    animManager.tracking = !!tgt
    const { time, state } = animManager

    // Actual animation logic
    switch (state) {
      case 'exited':
        initialState()
        break
      case 'entering':
        owlContainer.alpha = 1
        owlContainer.position.set(
          oriX - lerpEO(time, 0, toLandTime) * (oriX - x),
          oriY - lerpEO(time, 0, toLandTime) * (oriY - y),
        )
        switch (true) {
          case time < durationFade:
            if (!flySprite.playing) flySprite.play()
            flySprite.alpha = lerpLinear(time, 0, durationFade)
            break
          case toLandTime <= time && time < toIdleTime:
            if (!landSprite.playing) landSprite.play()
            flySprite.alpha = 0
            landSprite.alpha = 1
            break
          case time < toIdleTime:
            break
          default:
            animManager.transition()
        }
        break
      case 'entered':
        if (!idleSprite.playing) idleSprite.play()
        owlContainer.alpha = idleSprite.alpha = 1
        landSprite.alpha = flySprite.alpha = 0
        owlContainer.position.set(x, y)
        break
      case 'lost':
        switch (true) {
          case time < durationRetrack:
            // ugly visual glitch since loop no longer pefectly coincides
            if (landSprite.playing) landSprite.stop()
            break
          default:
            animManager.transition()
        }
        break
      case 'exiting':
        switch (true) {
          case time < durationFade:
            owlContainer.alpha = 1 - lerpLinear(time, 0, durationFade)
            break
          default:
            initialState()
            animManager.transition()
        }
        break
    }

    animManager.update(ticker.deltaMS / 1000)
  }

  return [owlContainer, update] as const
}

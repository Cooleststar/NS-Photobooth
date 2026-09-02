import { CommonAnimOpts, defaultAnimOpts, LocationTarget } from '.'
import * as PIXI from '../pixi'
import { AnimStateManager } from './AnimState'
import { createKFilter, lerpLinear } from './utils'

export interface SimpleFadeOpts extends CommonAnimOpts {
  /** url to load anim from */
  animUrl: string
}

export const simpleFadeDefaultOpts: Readonly<Required<SimpleFadeOpts>> = {
  ...defaultAnimOpts,
  animUrl: '',
}

export async function createSimpleFadePropAnim(
  app: PIXI.Application,
  opts: SimpleFadeOpts,
) {
  const { ticker, loader } = app

  const {
    animUrl,
    durationFade,
    durationRetrack,
    kalman,
    sizeFactor,
    xOffset,
    yOffset,
    flip,
  } = { ...simpleFadeDefaultOpts, ...opts }

  const container = new PIXI.Container()
  if (flip) container.scale.x = -1

  const sprite = await PIXI.ensureLoaded(loader, animUrl).then((r) => r.animation!.clone())
  sprite.anchor.set(0.5, 0.5)
  container.addChild(sprite)

  const animRatioWH = sprite.texture.width / sprite.texture.height

  const initialState = () => {
    sprite.alpha = 0
    sprite.stop()
    sprite.currentFrame = 0
  }
  initialState()

  const kfilter = createKFilter(kalman)
  const animManager = new AnimStateManager()

  let [x, y, size, angle] = [0, 0, 500, 0]
  const update = (tgt?: LocationTarget) => {
    if (tgt) {
      ;({ x, y, size, angle } = kfilter(tgt))
      size *= sizeFactor
      x += xOffset * size
      y += yOffset * size
    }

    sprite.height = size / animRatioWH
    sprite.width = size
    sprite.angle = angle

    animManager.tracking = !!tgt
    const { time, state } = animManager

    // Actual animation logic
    switch (state) {
      case 'exited':
        initialState()
        break
      case 'entering':
        container.position.set(x, y)
        switch (true) {
          case time < durationFade:
            if (!sprite.playing) sprite.play()
            sprite.alpha = lerpLinear(time, 0, durationFade)
            break
          default:
            animManager.transition()
        }
        break
      case 'entered':
        if (!sprite.playing) sprite.play()
        sprite.alpha = 1
        container.position.set(x, y)
        break
      case 'lost':
        switch (true) {
          case time < durationRetrack:
            break
          default:
            animManager.transition()
        }
        break
      case 'exiting':
        switch (true) {
          case time < durationFade * 2:
            sprite.alpha = 1 - lerpLinear(time, 0, durationFade)
            break
          default:
            initialState()
            animManager.transition()
        }
        break
    }

    animManager.update(ticker.deltaMS / 1000)
  }

  return [container, update] as const
}

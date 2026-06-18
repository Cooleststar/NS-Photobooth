import { CommonAnimOpts, defaultAnimOpts, LocationTarget } from '.'
import scanDisconnect from '../assets/scan_disconnect.gif'
import scanEntry from '../assets/scan_entry.gif'
import * as PIXI from '../pixi'
import { AnimStateManager } from './AnimState'
import { createKFilter, lerpLinear } from './utils'

export interface SimpleFadeOpts extends CommonAnimOpts {
  /** url to load anim from */
  animUrl: string
  useScanAnim?: boolean
}

export const simpleFadeDefaultOpts: Readonly<Required<SimpleFadeOpts>> = {
  ...defaultAnimOpts,
  animUrl: '',
  useScanAnim: false,
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
    useScanAnim,
  } = { ...simpleFadeDefaultOpts, ...opts }

  const container = new PIXI.Container()
  if (flip) container.scale.x = -1

  const [sprite, scanEntrySprite, scanExitSprite] = await Promise.all([
    PIXI.ensureLoaded(loader, animUrl).then((r) => r.animation!.clone()),
    useScanAnim
      ? PIXI.ensureLoaded(loader, scanEntry).then((r) => r.animation!.clone())
      : Promise.resolve(undefined),
    useScanAnim
      ? PIXI.ensureLoaded(loader, scanDisconnect).then((r) =>
          r.animation!.clone(),
        )
      : Promise.resolve(undefined),
  ])
  sprite.anchor.set(0.5, 0.5)
  container.addChild(sprite)

  if (useScanAnim) {
    scanEntrySprite!.anchor.set(0.5, 0.5)
    scanExitSprite!.anchor.set(0.5, 0.5)
    if (flip) {
      scanEntrySprite!.scale.x = -1
      scanExitSprite!.scale.x = -1
    }
    container.addChild(scanEntrySprite!, scanExitSprite!)
  }

  const animRatioWH = sprite.texture.width / sprite.texture.height

  const initialState = () => {
    sprite.alpha = 0
    sprite.stop()
    sprite.currentFrame = 0

    if (useScanAnim) {
      scanEntrySprite!.alpha = scanExitSprite!.alpha = 0
      scanEntrySprite!.stop()
      scanExitSprite!.stop()
      scanEntrySprite!.currentFrame = scanExitSprite!.currentFrame = 0
    }
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
            if (scanEntrySprite) {
              if (!scanEntrySprite.playing) scanEntrySprite.play()
              scanEntrySprite.alpha = lerpLinear(time, 0, durationFade / 2)
            }
            break
          default:
            animManager.transition()
        }
        break
      case 'entered':
        if (!sprite.playing) sprite.play()
        sprite.alpha = 1
        container.position.set(x, y)
        if (scanEntrySprite)
          scanEntrySprite.alpha = 1 - lerpLinear(time, 0, durationFade / 2)

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
            if (scanExitSprite) {
              if (!scanExitSprite.playing) scanExitSprite.play()
              scanExitSprite.alpha = 1
            }

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

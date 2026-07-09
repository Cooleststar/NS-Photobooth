import { NormalizedLandmarkList } from '@mediapipe/drawing_utils'
import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear, lerpEO } from './utils'
import { calculateArmFromPose, convertPoint } from '../api/nicepipe/mpPose'
import { AnimStateManager } from './AnimState'

import batFlyGif from '../assets/Bat_anim/Bat.gif'
import batSwoopGif from '../assets/Bat_anim/bat_swoop.gif'
import batVanishGif from '../assets/Bat_anim/bat_vanish.gif'
import batRestPng from '../assets/Bat_anim/Bat_rest.png'

/** anim duration & timing config */
const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
  RETRACK: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
  FLY_LOOPS: 2,
}

// R is system noisiness, Q is measurement noisiness
const KF_PARAMS = { R: 0.03, Q: 2 }

const BAT_MARGIN_B = 0.27

/** target coords for the bat to land assuming bottom-middle anchor
 * (same projection the owl uses to perch on the forearm) */
function calculateTarget(
  {
    x,
    y,
    angle,
    length,
  }: {
    x: number
    y: number
    angle: number
    length: number
  },
  arm: 'left' | 'right',
) {
  return {
    x: x - ((arm == 'right' ? 1 : -1) * (length * Math.cos(angle))) / 2,
    y: y + (length * Math.sin(angle)) / 2,
  }
}

function calculateBatSize(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
) {
  const leftEar = pose[7]
  const rightEar = pose[8]
  if (!leftEar || !rightEar) return 200
  const x1 = convertPoint(leftEar, height, width).x
  const x2 = convertPoint(rightEar, height, width).x
  return Math.max(150, Math.abs(x2 - x1) * 2.5)
}

export async function createBatAnim(app: PIXI.Application) {
  const {
    renderer: { height, width },
    ticker,
    loader,
  } = app
  const batContainer = new PIXI.Container()

  // cloning necessary for reuse since animation itself is a single sprite...
  const [restTexture, flySprite, landSprite, vanishSprite] = await Promise.all([
    PIXI.ensureLoaded(loader, batRestPng).then((res) => res.texture!),
    PIXI.ensureLoaded(loader, batFlyGif).then((res) => res.animation!.clone()),
    PIXI.ensureLoaded(loader, batSwoopGif).then((res) => res.animation!.clone()),
    PIXI.ensureLoaded(loader, batVanishGif).then((res) => res.animation!.clone()),
  ])

  const restSprite = PIXI.Sprite.from(restTexture)
  restSprite.anchor.set(0.5, 1)
  batContainer.addChild(restSprite)

  flySprite.anchor.set(0.5, 1)
  batContainer.addChild(flySprite)

  landSprite.anchor.set(0.5, 1)
  batContainer.addChild(landSprite)

  vanishSprite.anchor.set(0.5, 1)
  batContainer.addChild(vanishSprite)

  const initialState = () => {
    batContainer.alpha = 1
    batContainer.position.set(0, 0)
    flySprite.stop()
    landSprite.stop()
    vanishSprite.stop()
    restSprite.alpha = flySprite.alpha = landSprite.alpha = vanishSprite.alpha = 0
    flySprite.currentFrame = landSprite.currentFrame = vanishSprite.currentFrame = 0
  }
  initialState()

  const kf = {
    x: new KalmanFilter(KF_PARAMS),
    y: new KalmanFilter(KF_PARAMS),
    length: new KalmanFilter(KF_PARAMS),
    angle: new KalmanFilter(KF_PARAMS),
    batSize: new KalmanFilter(KF_PARAMS),
  }

  // NOTE: last fly loop included in landing animation
  /** time in seconds till land animation */
  const toLandTime = (flySprite.duration * ANIM.FLY_LOOPS) / 1000
  /** time in seconds till idle (resting) */
  const toIdleTime = toLandTime + landSprite.duration / 1000
  const vanishDuration = vanishSprite.duration / 1000
  let batSize = 150
  const animManager = new AnimStateManager()

  const update = (pose: NormalizedLandmarkList) => {
    let [arm, coords] = calculateArmFromPose(pose, height, width)
    if (coords) {
      coords = {
        x: kf.x.filter(coords.x),
        y: kf.y.filter(coords.y),
        angle: kf.angle.filter(coords.angle),
        length: kf.length.filter(coords.length),
      }
      batSize = kf.batSize.filter(calculateBatSize(pose, height, width))
    }

    let { x, y } = coords ? calculateTarget(coords, arm!) : { x: 0, y: 0 }
    y += batSize * BAT_MARGIN_B

    restSprite.height =
      restSprite.width =
      flySprite.height =
      flySprite.width =
      landSprite.height =
      landSprite.width =
      vanishSprite.height =
      vanishSprite.width =
        batSize

    animManager.tracking = !!coords
    const { time, state } = animManager

    switch (state) {
      case 'exited':
        initialState()
        break
      case 'entering':
        batContainer.alpha = 1
        batContainer.position.set(
          lerpEO(time, 0, toLandTime) * x,
          lerpEO(time, 0, toLandTime) * y,
        )
        switch (true) {
          case time < ANIM.FADE:
            if (!flySprite.playing) flySprite.play()
            flySprite.alpha = lerpLinear(time, 0, ANIM.FADE)
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
        batContainer.alpha = restSprite.alpha = 1
        landSprite.alpha = flySprite.alpha = 0
        batContainer.position.set(x, y)
        break
      case 'lost':
        switch (true) {
          case time < ANIM.RETRACK:
            break
          default:
            animManager.transition()
        }
        break
      case 'exiting':
        restSprite.alpha = flySprite.alpha = landSprite.alpha = 0
        if (!vanishSprite.playing) vanishSprite.play()
        if (time < vanishDuration) {
          vanishSprite.alpha = 1
          batContainer.alpha = 1 - lerpLinear(time, vanishDuration * 0.5, vanishDuration)
        } else {
          initialState()
          animManager.transition()
        }
        break
    }

    animManager.update(ticker.deltaMS / 1000)
  }

  return [batContainer, update] as const
}

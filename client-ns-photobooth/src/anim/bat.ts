import { NormalizedLandmarkList } from '@mediapipe/drawing_utils'
import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear, lerpEO } from './utils'
import { convertPoint } from '../api/nicepipe/mpPose'
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
// Resting pose rendered a bit smaller than the shared batSize, on request.
const REST_SIZE_FACTOR = 0.75
// Where along the forearm (elbow->wrist) the bat lands, as a fraction of
// that segment — 0 would be the elbow, 1 the wrist itself. Kept short of 1 so
// the bat perches on the forearm rather than on the hand.
const FOREARM_LAND_RATIO = 0.75
// Max allowed angle (degrees) between the upper arm (shoulder->elbow) and
// forearm (elbow->wrist) before the arm no longer counts as "straight" —
// the bat only lands/stays on a fully extended arm; bending the elbow past
// this makes getPalmTarget return undefined, which reads as tracking lost
// and sends the bat flying off (see the 'lost'/'exiting' states below).
const ARM_STRAIGHT_MAX_DEVIATION_DEG = 25

/** target coords for the bat to land on, assuming a bottom-middle anchor —
 * a point along the forearm (elbow->wrist, MP-33 indices 13/14 and 15/16),
 * short of the wrist so the bat perches on the forearm rather than the hand
 * (see FOREARM_LAND_RATIO). Picks whichever arm is tracked with higher
 * confidence, and only if that arm is straight (see
 * ARM_STRAIGHT_MAX_DEVIATION_DEG). Deliberately not using
 * calculateArmFromPose's elbow+angle+length reconstruction: that angle is
 * computed with Math.atan (not atan2), which can't recover which side of the
 * elbow the wrist is actually on, so it only ever looked right for the owl's
 * halfway-point perch — reaching further toward the wrist regularly landed on
 * the wrong side entirely. This uses plain vector subtraction instead, which
 * has no such sign ambiguity. */
function getForearmTarget(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
) {
  if (pose.length === 0) return undefined
  const ls = pose[11]
  const rs = pose[12]
  const le = pose[13]
  const re = pose[14]
  const lw = pose[15]
  const rw = pose[16]
  const leftVis = Math.min(ls?.visibility ?? 0, le?.visibility ?? 0, lw?.visibility ?? 0)
  const rightVis = Math.min(rs?.visibility ?? 0, re?.visibility ?? 0, rw?.visibility ?? 0)
  if (leftVis < 0.5 && rightVis < 0.5) return undefined

  const useLeft = leftVis >= rightVis
  const shoulder = convertPoint(useLeft ? ls : rs, height, width)
  const elbow = convertPoint(useLeft ? le : re, height, width)
  const wrist = convertPoint(useLeft ? lw : rw, height, width)

  const upperArm = { x: elbow.x - shoulder.x, y: elbow.y - shoulder.y }
  const forearm = { x: wrist.x - elbow.x, y: wrist.y - elbow.y }
  const upperArmLen = Math.hypot(upperArm.x, upperArm.y)
  const forearmLen = Math.hypot(forearm.x, forearm.y)
  if (upperArmLen < 1 || forearmLen < 1) return undefined

  const cosDeviation =
    (upperArm.x * forearm.x + upperArm.y * forearm.y) / (upperArmLen * forearmLen)
  const maxCos = Math.cos((ARM_STRAIGHT_MAX_DEVIATION_DEG * Math.PI) / 180)
  if (cosDeviation < maxCos) return undefined

  return {
    x: elbow.x + (wrist.x - elbow.x) * FOREARM_LAND_RATIO,
    y: elbow.y + (wrist.y - elbow.y) * FOREARM_LAND_RATIO,
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
  // Bat_rest.png is a wide, non-square image (648x396) — forcing it into the
  // same square batSize as the other sprites squashed it visibly. Scale its
  // width off its own natural aspect ratio instead, so it renders undistorted.
  const restAspect = restTexture.width / restTexture.height

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
    const target = getForearmTarget(pose, height, width)
    let x = 0
    let y = 0
    if (target) {
      x = kf.x.filter(target.x)
      y = kf.y.filter(target.y)
      batSize = kf.batSize.filter(calculateBatSize(pose, height, width))
    }

    y += batSize * BAT_MARGIN_B

    restSprite.height = batSize * REST_SIZE_FACTOR
    restSprite.width = batSize * REST_SIZE_FACTOR * restAspect

    flySprite.height =
      flySprite.width =
      landSprite.height =
      landSprite.width =
      vanishSprite.height =
      vanishSprite.width =
        batSize

    animManager.tracking = !!target
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

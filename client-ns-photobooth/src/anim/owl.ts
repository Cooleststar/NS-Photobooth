import { NormalizedLandmarkList } from '@mediapipe/drawing_utils'
import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear, lerpEO } from './utils'
import { calculateArmFromPose, convertPoint } from '../api/nicepipe/mpPose'
import { AnimStateManager } from './AnimState'

import owlIdleGif from '../assets/owl_anim/owl_idle_new.gif'
import owlFlyGif from '../assets/owl_anim/owl_flying_new.gif'
import owlLandGif from '../assets/owl_anim/owl_landing_new.gif'
import { freezePosition } from '../store'

/** anim duration & timing config */
const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
  RETRACK: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
  FLY_LOOPS: parseFloat(import.meta.env.VITE_ANIM_OWL_FLY_LOOPS), // roughly 5 seconds per 4 loops
}

// R is system noisiness, Q is measurement noisiness
// see https://www.wouterbulten.nl/blog/tech/lightweight-javascript-library-for-noise-filtering/
// i guess and checked this values
const KF_PARAMS = { R: 0.03, Q: 2 }

const OWL_MARGIN_B = 0.27

/** target coords for owl to land assuming bottom-middle anchor */
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
    // NOTE: bug here when arm is extended instead of held in front of chest
    // should check angle to know
    // but the result of the bug looks cool so I'm leaving it
    x: x - ((arm == 'right' ? 1 : -1) * (length * Math.cos(angle))) / 2,
    y: y + (length * Math.sin(angle)) / 2,
  }
}

function calculateOwlSize(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
) {
  //owl_size = Math.max(100, coords ? coords.length * 1.2 : owl_size)
  const leftEar = pose[7]
  const rightEar = pose[8]
  const x1 = convertPoint(leftEar, height, width).x
  const x2 = convertPoint(rightEar, height, width).x
  return Math.max(300, Math.abs(x2 - x1) * 3)
}

/* TODO: should a ref really be used for the pose?
 * using context would make the function impure
 * (using ref already makes it impure)
 */
export async function createOwlAnim(app: PIXI.Application) {
  const {
    renderer: { height, width },
    ticker,
    loader,
  } = app
  const owlContainer = new PIXI.Container()

  // cloning necessary for reuse since animation itself is a single sprite...
  const [idleSprite, flySprite, landSprite] = await Promise.all([
    PIXI.ensureLoaded(loader, owlIdleGif).then((res) => res.animation!.clone()),
    PIXI.ensureLoaded(loader, owlFlyGif).then((res) => res.animation!.clone()),
    PIXI.ensureLoaded(loader, owlLandGif).then((res) => res.animation!.clone()),
  ])

  idleSprite.anchor.set(0.5, 1)
  owlContainer.addChild(idleSprite)

  flySprite.anchor.set(0.5, 1)
  owlContainer.addChild(flySprite)

  landSprite.anchor.set(0.5, 1)
  owlContainer.addChild(landSprite)

  const initialState = () => {
    owlContainer.alpha = 1
    owlContainer.position.set(0, 0)
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

  const kf = {
    x: new KalmanFilter(KF_PARAMS),
    y: new KalmanFilter(KF_PARAMS),
    length: new KalmanFilter(KF_PARAMS),
    angle: new KalmanFilter(KF_PARAMS),
    owlSize: new KalmanFilter(KF_PARAMS),
  }

  // NOTE: last fly loop included in landing animation
  /** time in seconds till land animation */
  const toLandTime = (flySprite.duration * ANIM.FLY_LOOPS) / 1000
  /** time in seconds till idle animation */
  const toIdleTime = toLandTime + landSprite.duration / 1000
  let owlSize = 100
  // Last landing spot the arm heuristic actually found — kept around so a
  // person who's still clearly in frame (just not holding their arm in the
  // exact ~horizontal pose calculateArmFromPose requires: mid-gesture,
  // slightly different angle, momentary low landmark confidence) doesn't
  // make the owl flicker away. Only losing the person's pose entirely
  // (pose.length === 0) counts as actually gone.
  let lastCoords: { x: number; y: number; angle: number; length: number } | undefined
  let lastArm: 'left' | 'right' | undefined
  const animManager = new AnimStateManager()
  const update = (pose: NormalizedLandmarkList) => {
    // Determining size and location
    let [arm, coords] = calculateArmFromPose(pose, height, width)
    if (coords) {
      coords = {
        x: kf.x.filter(coords.x),
        y: kf.y.filter(coords.y),
        angle: kf.angle.filter(coords.angle),
        length: kf.length.filter(coords.length),
      }
      // adjust size only if pose detected
      owlSize = kf.owlSize.filter(calculateOwlSize(pose, height, width))
      lastCoords = coords
      lastArm = arm
    }

    // console.log(animState, coords)

    // transform calculations — fall back to the last known perch so a
    // momentary arm-angle miss doesn't snap the owl back to (0, 0)
    const landingCoords = coords ?? lastCoords
    const landingArm = arm ?? lastArm
    let { x, y } = landingCoords ? calculateTarget(landingCoords, landingArm!) : { x: 0, y: 0 }
    y += owlSize * OWL_MARGIN_B //adjust owl downwards

    idleSprite.height =
      idleSprite.width =
      flySprite.height =
      flySprite.width =
      landSprite.height =
      landSprite.width =
        owlSize

    animManager.tracking = pose.length > 0
    const { time, state } = animManager

    // Actual animation logic
    switch (state) {
      case 'exited':
        initialState()
        break
      case 'entering':
        owlContainer.alpha = 1
        owlContainer.position.set(
          lerpEO(time, 0, toLandTime) * x,
          lerpEO(time, 0, toLandTime) * y,
        )
        switch (true) {
          case time < ANIM.FADE:
            if (!flySprite.playing) flySprite.play()
            flySprite.alpha = lerpLinear(time, 0, ANIM.FADE)
            break
          case toLandTime <= time && time < toIdleTime:
            // Done flying — stop it rather than just hiding it. Leaving it
            // playing (even at alpha 0) meant it kept decoding/looping its
            // full frame sequence in the background for the rest of the
            // owl's lifetime, for no visible benefit — this is very likely
            // why the owl carries a much higher steady-state render cost
            // than the drone, which only ever has one sprite to begin with.
            if (flySprite.playing) flySprite.stop()
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
        if (landSprite.playing) landSprite.stop()
        if (flySprite.playing) flySprite.stop()
        if (!idleSprite.playing) idleSprite.play()
        owlContainer.alpha = idleSprite.alpha = 1
        landSprite.alpha = flySprite.alpha = 0
        if (!freezePosition.get()) owlContainer.position.set(x, y)
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
        switch (true) {
          case time < ANIM.FADE:
            owlContainer.alpha = 1 - lerpLinear(time, 0, ANIM.FADE)
            break
          default:
            // if redetected on next frame, case 'exited' might never get to run
            // hence reset here too
            initialState()
            animManager.transition()
        }
        break
    }

    animManager.update(ticker.deltaMS / 1000)
  }

  return [owlContainer, update] as const
}

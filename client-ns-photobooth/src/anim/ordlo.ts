import { NormalizedLandmarkList } from '@mediapipe/drawing_utils'
import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear } from './utils'
import { convertPoint } from '../api/nicepipe/mpPose'
import { AnimStateManager } from './AnimState'

import ordloImg from '../assets/text_banner/ORDLO/ORDLO_grad_bold.png'

const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
  RETRACK: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
}

const KF_PARAMS = { R: 0.03, Q: 2 }

// Source is 308x53 — a wide wordmark, not a square prop, so it's scaled by
// width (relative to ear-to-ear distance, the usual "how big is the head on
// screen" proxy in this pipeline) with height derived from its own aspect
// ratio, rather than forcing a square like the face-mask characters do.
const ORDLO_ASPECT = 53 / 308
const WIDTH_FACTOR = 1.6 // width relative to ear-to-ear distance
// How far above the nose the banner's own vertical center sits, in
// multiples of ear-to-ear distance — clears the hairline for a normal head
// tilt without floating disconnected from it.
const HEAD_CLEARANCE_FACTOR = 1.1

// Continuous bob rather than the one-shot landing bounce other characters
// use elsewhere — this one's meant to keep hopping the whole time it's on
// screen. Math.abs(sin) instead of a plain sine so it always reads as
// hopping *up* off a resting line rather than swinging both above and
// below it.
const BOUNCE_SPEED = 4.5
const BOUNCE_AMPLITUDE_FACTOR = 0.35 // relative to the banner's own width

// Confetti keeps firing on both sides for as long as this is on screen,
// not just once on spawn — see the trigger callback passed into
// createOrdloAnim.
const CONFETTI_INTERVAL_SEC = 0.5
const CONFETTI_SIDE_GAP_FACTOR = 0.65 // gap from banner edge to burst point, relative to its width

// A jump larger than this (in multiples of ear-to-ear distance) means this
// slot has been handed to a different person, not that someone moved —
// same reasoning as every other face-anchored character in this codebase.
const REBIND_SNAP_RATIO = 2.5

function getHeadTarget(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
) {
  if (pose.length === 0) return undefined
  const nose = pose[0]
  const leftEar = pose[7]
  const rightEar = pose[8]
  if (!nose || !leftEar || !rightEar) return undefined
  if ((nose.visibility ?? 1) < 0.5) return undefined
  if ((leftEar.visibility ?? 1) < 0.3 && (rightEar.visibility ?? 1) < 0.3) return undefined

  const n = convertPoint(nose, height, width)
  const le = convertPoint(leftEar, height, width)
  const re = convertPoint(rightEar, height, width)
  const earDist = Math.hypot(le.x - re.x, le.y - re.y)
  if (earDist < 1) return undefined

  return {
    x: n.x,
    y: n.y - earDist * HEAD_CLEARANCE_FACTOR,
    bannerWidth: earDist * WIDTH_FACTOR,
  }
}

export async function createOrdloAnim(
  app: PIXI.Application,
  /** Fires one confetti burst at a screen position — shared with whatever
   * else in the scene is using confetti (see createConfettiBurst), so this
   * character doesn't need its own particle system just to flank itself
   * with bursts on both sides. */
  burstConfetti?: (x: number, y: number) => void,
) {
  const {
    renderer: { height, width },
    ticker,
    loader,
  } = app

  const container = new PIXI.Container()
  const { texture } = await PIXI.ensureLoaded(loader, ordloImg)
  const sprite = PIXI.Sprite.from(texture!)
  sprite.anchor.set(0.5, 0.5)
  container.addChild(sprite)

  const kf = {
    x: new KalmanFilter(KF_PARAMS),
    y: new KalmanFilter(KF_PARAMS),
    size: new KalmanFilter(KF_PARAMS),
  }
  let bound = false

  const initialState = () => {
    container.alpha = 0
    bound = false
  }
  initialState()

  let x = 0
  let y = 0
  let bannerWidth = 200
  let bounceTime = 0
  let confettiTime = 0
  const animManager = new AnimStateManager()

  const update = (pose: NormalizedLandmarkList) => {
    const target = getHeadTarget(pose, height, width)
    if (target) {
      const jumped = bound && Math.hypot(target.x - x, target.y - y) > target.bannerWidth * REBIND_SNAP_RATIO
      if (jumped || !bound) {
        // Fresh person for this slot: discard the old filter state so the
        // banner appears on them rather than travelling there.
        kf.x = new KalmanFilter(KF_PARAMS)
        kf.y = new KalmanFilter(KF_PARAMS)
        kf.size = new KalmanFilter(KF_PARAMS)
        bound = true
        bounceTime = 0
      }
      x = kf.x.filter(target.x)
      y = kf.y.filter(target.y)
      bannerWidth = kf.size.filter(target.bannerWidth)
    }

    sprite.width = bannerWidth
    sprite.height = bannerWidth * ORDLO_ASPECT

    animManager.tracking = !!target
    const { time, state } = animManager

    switch (state) {
      case 'exited':
        initialState()
        bounceTime = 0
        confettiTime = 0
        break

      case 'entering':
        container.alpha = lerpLinear(time, 0, ANIM.FADE)
        container.position.set(x, y)
        if (time >= ANIM.FADE) animManager.transition()
        break

      case 'entered': {
        container.alpha = 1

        bounceTime += ticker.deltaMS / 1000
        const bounceOffset = -Math.abs(Math.sin(bounceTime * BOUNCE_SPEED)) * bannerWidth * BOUNCE_AMPLITUDE_FACTOR
        container.position.set(x, y + bounceOffset)

        if (burstConfetti) {
          confettiTime += ticker.deltaMS / 1000
          if (confettiTime >= CONFETTI_INTERVAL_SEC) {
            confettiTime = 0
            const gap = bannerWidth / 2 + bannerWidth * CONFETTI_SIDE_GAP_FACTOR
            burstConfetti(x - gap, y + bounceOffset)
            burstConfetti(x + gap, y + bounceOffset)
          }
        }
        break
      }

      case 'lost':
        if (time >= ANIM.RETRACK) animManager.transition()
        break

      case 'exiting':
        container.alpha = 1 - lerpLinear(time, 0, ANIM.FADE)
        if (time >= ANIM.FADE) {
          initialState()
          animManager.transition()
        }
        break
    }

    animManager.update(ticker.deltaMS / 1000)
  }

  return [container, update] as const
}

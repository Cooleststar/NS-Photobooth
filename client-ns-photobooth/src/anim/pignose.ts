import { NormalizedLandmarkList } from '@mediapipe/drawing_utils'
import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear } from './utils'
import { convertPoint } from '../api/nicepipe/mpPose'
import { AnimStateManager } from './AnimState'

import pigNoseImg from '../assets/Pignose/Pignose.png'

const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
  RETRACK: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
}

const KF_PARAMS = { R: 0.03, Q: 2 }

// Snout width as a fraction of ear-to-ear distance (roughly head width).
// Much smaller than clown/pig's FACE_SIZE_FACTOR because this covers just
// the nose rather than the whole face. This is the knob to turn if the
// snout looks too big or too small on real faces.
const NOSE_SIZE_FACTOR = 0.6

// Same rebind guard as clown.ts/pig.ts: a jump larger than this (in
// multiples of snout size) means this slot has been handed to a different
// person, not that someone moved. Snap rather than let the filter drag the
// snout across the frame and over somebody else's face. Scaled off a
// smaller sprite than the face masks, so the absolute threshold is tighter.
const REBIND_SNAP_RATIO = 3.0

/** Nose position, head scale and tilt from MP-33 pose landmarks
 * (nose=0, ears=7/8). Same sparse-face-point approach as clown.ts/pig.ts —
 * there's no face-mesh detector in this pipeline, so the face points already
 * present in body pose are reused. The nose landmark is what the snout is
 * pinned to; the ears only supply scale and roll. */
function getNoseTarget(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
) {
  if (pose.length === 0) return undefined
  const nose = pose[0]
  const leftEar = pose[7]
  const rightEar = pose[8]
  if (!nose || !leftEar || !rightEar) return undefined
  // The nose itself must be solid — it's the anchor, so a weak detection
  // here would park the snout somewhere arbitrary on the face.
  if ((nose.visibility ?? 1) < 0.5) return undefined
  if ((leftEar.visibility ?? 1) < 0.3 && (rightEar.visibility ?? 1) < 0.3) return undefined

  const n = convertPoint(nose, height, width)
  const le = convertPoint(leftEar, height, width)
  const re = convertPoint(rightEar, height, width)

  const earDist = Math.hypot(le.x - re.x, le.y - re.y)
  if (earDist < 1) return undefined

  // Roll from the ear-to-ear line, so the snout tilts with the head.
  const angle = Math.atan2(re.y - le.y, re.x - le.x)

  return { x: n.x, y: n.y, size: earDist * NOSE_SIZE_FACTOR, angle }
}

export async function createPigNoseAnim(app: PIXI.Application) {
  const {
    renderer: { height, width },
    ticker,
    loader,
  } = app

  const container = new PIXI.Container()
  const { texture } = await PIXI.ensureLoaded(loader, pigNoseImg)
  const sprite = PIXI.Sprite.from(texture!)
  sprite.anchor.set(0.5, 0.5)
  container.addChild(sprite)

  const makeFilters = () => ({
    x: new KalmanFilter(KF_PARAMS),
    y: new KalmanFilter(KF_PARAMS),
    size: new KalmanFilter(KF_PARAMS),
    angle: new KalmanFilter(KF_PARAMS),
  })
  let kf = makeFilters()
  // whether kf currently holds a recent target belonging to this same person
  let bound = false

  const initialState = () => {
    container.alpha = 0
    bound = false
  }
  initialState()

  let x = 0
  let y = 0
  let size = 60
  let angle = 0
  const animManager = new AnimStateManager()

  const update = (pose: NormalizedLandmarkList) => {
    const target = getNoseTarget(pose, height, width)
    if (target) {
      const jumped =
        bound && Math.hypot(target.x - x, target.y - y) > target.size * REBIND_SNAP_RATIO
      if (jumped || !bound) {
        // Fresh person for this slot: drop the old person's filter state so
        // the snout appears on them rather than travelling there.
        kf = makeFilters()
        bound = true
      }
      x = kf.x.filter(target.x)
      y = kf.y.filter(target.y)
      size = kf.size.filter(target.size)
      angle = kf.angle.filter(target.angle)
    }

    sprite.width = sprite.height = size
    container.rotation = angle

    animManager.tracking = !!target
    const { time, state } = animManager

    switch (state) {
      case 'exited':
        initialState()
        break

      case 'entering':
        container.alpha = lerpLinear(time, 0, ANIM.FADE)
        container.position.set(x, y)
        if (time >= ANIM.FADE) animManager.transition()
        break

      case 'entered':
        container.alpha = 1
        container.position.set(x, y)
        break

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

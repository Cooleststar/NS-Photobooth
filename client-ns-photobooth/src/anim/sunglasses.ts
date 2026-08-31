import { NormalizedLandmarkList } from '@mediapipe/drawing_utils'
import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear } from './utils'
import { convertPoint } from '../api/nicepipe/mpPose'
import { AnimStateManager } from './AnimState'

import sunglassesImg from '../assets/Sunglasses/Sunglasses.png'

const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
  RETRACK: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
}

const KF_PARAMS = { R: 0.03, Q: 2 }

// ---------------------------------------------------------------------------
// Art geometry — measured from Sunglasses.png's alpha channel, not guessed.
// 640x255 pixel-art frames, front-facing and bbox-centred (content spans x
// 0.102..0.898, y 0.282..0.737 — centre sits at 0.500, 0.510), so a plain
// centre anchor lines the frame up with the face without needing a custom
// anchor point the way the wig/ear props do.
//
// Note the aspect: this art is 2.51:1 where the previous photo-real pair was
// 2:1, so the frames render proportionally shorter for the same width. That
// falls out of the texture aspect automatically below — nothing to tune.
// ---------------------------------------------------------------------------

/** How much of the image's width the visible frame occupies. Used to convert
 * a *desired visible width* (relative to ear-to-ear distance) into the full
 * sprite width PIXI needs to be told. */
const CONTENT_WIDTH_FRACTION = 0.797

/** Desired *visible* width of the glasses, relative to ear-to-ear distance.
 * Real frames span most of the face's width at eye level, which is a touch
 * narrower than at the ears themselves. Tune this if they look too big or
 * too small on real faces. */
const VISIBLE_SIZE_FACTOR = 0.95

/** How far above the nose tip the glasses sit, as a fraction of ear-to-ear
 * distance — the nose landmark is the tip, not the eye line, so this lifts
 * the frame up to bridge height. Tune this if they sit too high/low. */
const EYE_LIFT_FACTOR = 0.22

// A jump larger than this (in ear-to-ear distances) means this animation slot
// has been handed to a different person, not that someone moved quickly. Snap
// to the new face rather than letting the filter drag the glasses across the
// frame. Same guard as pignose.ts/clownwignose.ts.
const REBIND_SNAP_RATIO = 1.5

// The nose landmark anchors the costume, so a weak detection there would park
// it somewhere arbitrary. Ears only supply scale and roll, so one visible ear
// is enough to survive a profile turn.
const NOSE_VISIBILITY_MIN = 0.5
const EAR_VISIBILITY_MIN = 0.3

/** Glasses position, head scale and roll from MP-33 pose landmarks (nose=0,
 * ears=7/8). Same sparse-face-point approach as the other face props — there
 * is no face-mesh detector in this pipeline, so the face points already
 * present in body pose are reused. */
function getFaceTarget(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
) {
  if (pose.length === 0) return undefined
  const nose = pose[0]
  const leftEar = pose[7]
  const rightEar = pose[8]
  if (!nose || !leftEar || !rightEar) return undefined
  if ((nose.visibility ?? 1) < NOSE_VISIBILITY_MIN) return undefined
  if (
    (leftEar.visibility ?? 1) < EAR_VISIBILITY_MIN &&
    (rightEar.visibility ?? 1) < EAR_VISIBILITY_MIN
  ) {
    return undefined
  }

  const n = convertPoint(nose, height, width)
  const le = convertPoint(leftEar, height, width)
  const re = convertPoint(rightEar, height, width)

  const earDist = Math.hypot(le.x - re.x, le.y - re.y)
  if (earDist < 1) return undefined

  // Roll from the ear-to-ear line, so the glasses tilt with the head.
  const angle = Math.atan2(re.y - le.y, re.x - le.x)

  // "Up" is perpendicular to the ear line rather than screen-up, so the
  // glasses stay on the head when it tilts instead of sliding off sideways.
  const upX = Math.sin(angle)
  const upY = -Math.cos(angle)

  return {
    x: n.x + upX * earDist * EYE_LIFT_FACTOR,
    y: n.y + upY * earDist * EYE_LIFT_FACTOR,
    earDist,
    angle,
  }
}

export async function createSunglassesAnim(app: PIXI.Application) {
  const {
    renderer: { height, width },
    ticker,
    loader,
  } = app

  const container = new PIXI.Container()

  const { texture: glassesTex } = await PIXI.ensureLoaded(loader, sunglassesImg)

  const glasses = PIXI.Sprite.from(glassesTex!)
  glasses.anchor.set(0.5, 0.5)
  container.addChild(glasses)

  const makeFilters = () => ({
    x: new KalmanFilter(KF_PARAMS),
    y: new KalmanFilter(KF_PARAMS),
    size: new KalmanFilter(KF_PARAMS),
    angle: new KalmanFilter(KF_PARAMS),
  })
  let filters = makeFilters()
  // whether filters currently hold a recent target belonging to this same person
  let bound = false

  const initialState = () => {
    container.alpha = 0
    bound = false
  }
  initialState()

  let x = 0
  let y = 0
  let earDist = 100
  let angle = 0
  const animManager = new AnimStateManager()

  const update = (pose: NormalizedLandmarkList) => {
    const target = getFaceTarget(pose, height, width)
    if (target) {
      const jumped =
        bound &&
        Math.hypot(target.x - x, target.y - y) > target.earDist * REBIND_SNAP_RATIO
      if (jumped || !bound) {
        // Fresh person for this slot: drop the old person's filter state so
        // the glasses appear on them rather than travelling there.
        filters = makeFilters()
        bound = true
      }
      x = filters.x.filter(target.x)
      y = filters.y.filter(target.y)
      earDist = filters.size.filter(target.earDist)
      angle = filters.angle.filter(target.angle)
    }

    glasses.width = (earDist * VISIBLE_SIZE_FACTOR) / CONTENT_WIDTH_FRACTION
    glasses.height = glasses.width * (glassesTex!.height / glassesTex!.width)
    glasses.rotation = angle

    animManager.tracking = !!target
    const { time, state } = animManager

    const place = () => {
      glasses.position.set(x, y)
    }

    switch (state) {
      case 'exited':
        initialState()
        break

      case 'entering':
        container.alpha = lerpLinear(time, 0, ANIM.FADE)
        place()
        if (time >= ANIM.FADE) animManager.transition()
        break

      case 'entered':
        container.alpha = 1
        place()
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

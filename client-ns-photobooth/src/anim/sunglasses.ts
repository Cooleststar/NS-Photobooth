import { NormalizedLandmarkList } from '../api/landmarks'
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
// 494x505 canvas; the frame spans the full width edge-to-edge (arms are
// cropped right at the image border, no side padding) but only a thin
// horizontal band vertically (content y 0.398..0.592). Content is
// bbox-centred at (0.499, 0.496), so a plain centre anchor still lines the
// frame up with the face without needing a custom anchor point the way the
// wig/ear props do.
//
// The height PIXI renders comes out of the texture's own aspect ratio
// (~1:1) automatically below — nothing to tune there.
// ---------------------------------------------------------------------------

/** How much of the image's width the visible frame occupies. Used to convert
 * a *desired visible width* (relative to ear-to-ear distance) into the full
 * sprite width PIXI needs to be told. */
const CONTENT_WIDTH_FRACTION = 1.0

/** Desired *visible* width of the glasses, relative to ear-to-ear distance.
 * Real frames span most of the face's width at eye level, which is a touch
 * narrower than at the ears themselves. Tune this if they look too big or
 * too small on real faces. */
const VISIBLE_SIZE_FACTOR = 0.95

// A jump larger than this (in ear-to-ear distances) means this animation slot
// has been handed to a different person, not that someone moved quickly. Snap
// to the new face rather than letting the filter drag the glasses across the
// frame. Same guard as pignose.ts/clownwignose.ts.
const REBIND_SNAP_RATIO = 1.5

// Ears only supply scale (earDist) and, when both eyes aren't available, roll
// — one visible ear is enough to survive a profile turn there.
const EYE_VISIBILITY_MIN = 0.5
const EAR_VISIBILITY_MIN = 0.3

/** Glasses position, head scale and roll from MP-33 pose landmarks (left
 * eye=2, right eye=5, ears=7/8). Positioned directly on the eye landmarks —
 * not the nose plus a guessed lift factor, which only approximated eye
 * height — so the frame actually covers the eyes rather than sitting
 * wherever that approximation happened to land. Same sparse-face-point
 * approach as the other face props otherwise: there is no face-mesh
 * detector in this pipeline, so the face points already present in body
 * pose are reused. */
function getFaceTarget(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
) {
  if (pose.length === 0) return undefined
  const leftEye = pose[2]
  const rightEye = pose[5]
  const leftEar = pose[7]
  const rightEar = pose[8]
  if (!leftEye || !rightEye || !leftEar || !rightEar) return undefined

  const leftEyeVisible = (leftEye.visibility ?? 1) >= EYE_VISIBILITY_MIN
  const rightEyeVisible = (rightEye.visibility ?? 1) >= EYE_VISIBILITY_MIN
  if (!leftEyeVisible && !rightEyeVisible) return undefined
  if (
    (leftEar.visibility ?? 1) < EAR_VISIBILITY_MIN &&
    (rightEar.visibility ?? 1) < EAR_VISIBILITY_MIN
  ) {
    return undefined
  }

  const le = convertPoint(leftEar, height, width)
  const re = convertPoint(rightEar, height, width)
  const earDist = Math.hypot(le.x - re.x, le.y - re.y)
  if (earDist < 1) return undefined

  const leftE = convertPoint(leftEye, height, width)
  const rightE = convertPoint(rightEye, height, width)

  let x: number
  let y: number
  let angle: number
  if (leftEyeVisible && rightEyeVisible) {
    // Both eyes tracked: sit right on their midpoint, and take roll directly
    // from the eye-to-eye line — the most direct signal available for how
    // glasses specifically should tilt, more so than the general head-tilt
    // the ear line approximates.
    x = (leftE.x + rightE.x) / 2
    y = (leftE.y + rightE.y) / 2
    angle = Math.atan2(rightE.y - leftE.y, rightE.x - leftE.x)
  } else {
    // Profile turn: only one eye is a real detection, the other is the pose
    // model's best guess for an occluded point (usually collapsed toward the
    // visible one) — averaging them in would pull the glasses off-target, so
    // anchor on the one real eye instead. Roll still comes from the ear
    // line, which stays valid in profile.
    const visible = leftEyeVisible ? leftE : rightE
    x = visible.x
    y = visible.y
    angle = Math.atan2(re.y - le.y, re.x - le.x)
  }

  return { x, y, earDist, angle }
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

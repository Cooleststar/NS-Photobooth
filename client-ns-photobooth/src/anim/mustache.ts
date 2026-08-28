import { NormalizedLandmarkList } from '@mediapipe/drawing_utils'
import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear } from './utils'
import { convertPoint } from '../api/nicepipe/mpPose'
import { AnimStateManager } from './AnimState'

import mustacheImg from '../assets/Mustache/mustache.png'

const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
  RETRACK: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
}

const KF_PARAMS = { R: 0.03, Q: 2 }

// ---------------------------------------------------------------------------
// Art geometry — measured from mustache.png's alpha channel, not guessed.
// 677x369, content spans x 0.059..0.939 (centred at x=0.499) and y
// 0.255..0.764. Unlike sunglasses.png this one isn't vertically centred —
// what needs to line up with the face is the little peak where the two
// halves meet under the septum, which sits at y=0.325 of the image, not the
// bbox's vertical middle (0.510).
// ---------------------------------------------------------------------------

/** Where the mustache's own attachment point (the peak under the septum)
 * sits in the artwork, as a fraction of the image. Anchoring here — rather
 * than the sprite/bbox centre — is what lets it be pinned directly under the
 * nose instead of floating too high or too low. */
const NOSE_ANCHOR = { x: 0.5, y: 0.325 }

/** How much of the image's width the visible hair occupies. Used to convert
 * a *desired visible width* (relative to ear-to-ear distance) into the full
 * sprite width PIXI needs to be told. */
const CONTENT_WIDTH_FRACTION = 0.880

/** Desired *visible* width of the mustache, relative to ear-to-ear distance.
 * A mustache spans roughly the mouth's width, well under the full head width
 * that sunglasses/wig props use. Tune this if it looks too big or too small
 * on real faces. */
const VISIBLE_SIZE_FACTOR = 0.5

/** How far below the nose tip the mustache sits, as a fraction of ear-to-ear
 * distance. The nose landmark (MP-33 index 0) lands at the tip itself, well
 * above the upper lip, so this needs to be a real drop (comparable to
 * sunglasses.ts's EYE_LIFT_FACTOR, not a token nudge) to clear the nose
 * entirely and land on the lip. Was 0.03, which barely moved it off the
 * nose. Tune this if it sits too high/low. */
const NOSE_DROP_FACTOR = 0.18

// A jump larger than this (in ear-to-ear distances) means this animation slot
// has been handed to a different person, not that someone moved quickly. Snap
// to the new face rather than letting the filter drag the mustache across the
// frame. Same guard as pignose.ts/sunglasses.ts.
const REBIND_SNAP_RATIO = 1.5

// The nose landmark anchors the costume, so a weak detection here would park
// it somewhere arbitrary. Ears only supply scale and roll, so one visible ear
// is enough to survive a profile turn.
const NOSE_VISIBILITY_MIN = 0.5
const EAR_VISIBILITY_MIN = 0.3

/** Mustache position, head scale and roll from MP-33 pose landmarks (nose=0,
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

  // Roll from the ear-to-ear line, so the mustache tilts with the head.
  const angle = Math.atan2(re.y - le.y, re.x - le.x)

  // "Down" is perpendicular to the ear line rather than screen-down, so the
  // mustache stays under the nose when the head tilts instead of sliding off
  // sideways.
  const downX = -Math.sin(angle)
  const downY = Math.cos(angle)

  return {
    x: n.x + downX * earDist * NOSE_DROP_FACTOR,
    y: n.y + downY * earDist * NOSE_DROP_FACTOR,
    earDist,
    angle,
  }
}

export async function createMustacheAnim(app: PIXI.Application) {
  const {
    renderer: { height, width },
    ticker,
    loader,
  } = app

  const container = new PIXI.Container()

  const { texture: mustacheTex } = await PIXI.ensureLoaded(loader, mustacheImg)

  const mustache = PIXI.Sprite.from(mustacheTex!)
  mustache.anchor.set(NOSE_ANCHOR.x, NOSE_ANCHOR.y)
  container.addChild(mustache)

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
        // the mustache appears on them rather than travelling there.
        filters = makeFilters()
        bound = true
      }
      x = filters.x.filter(target.x)
      y = filters.y.filter(target.y)
      earDist = filters.size.filter(target.earDist)
      angle = filters.angle.filter(target.angle)
    }

    mustache.width = (earDist * VISIBLE_SIZE_FACTOR) / CONTENT_WIDTH_FRACTION
    mustache.height = mustache.width * (mustacheTex!.height / mustacheTex!.width)
    mustache.rotation = angle

    animManager.tracking = !!target
    const { time, state } = animManager

    const place = () => {
      mustache.position.set(x, y)
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

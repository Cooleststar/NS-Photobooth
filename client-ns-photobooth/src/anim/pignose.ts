import { NormalizedLandmarkList } from '@mediapipe/drawing_utils'
import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear } from './utils'
import { convertPoint } from '../api/nicepipe/mpPose'
import { AnimStateManager } from './AnimState'

import pigNoseImg from '../assets/Pignose/Pignose.png'
import pigEarImg from '../assets/Pignose/PigEar.png'

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

// Same rebind guard as clownwignose.ts: a jump larger than this (in
// multiples of snout size) means this slot has been handed to a different
// person, not that someone moved. Snap rather than let the filter drag the
// snout across the frame and over somebody else's face. Scaled off a
// smaller sprite than the face masks, so the absolute threshold is tighter.
const REBIND_SNAP_RATIO = 3.0

// ---------------------------------------------------------------------------
// Ear art geometry — measured from PigEar.png's alpha channel, not guessed.
//
// Unlike batears.ts, both ears are baked into a single 260x280 image (a
// symmetric pair, no left/right split needed). Alpha bbox: x 0.085..0.915,
// y 0.254..0.511 — so the content is centred horizontally (good, matches the
// head's own left-right symmetry) and its bottom edge (where the ears meet
// the head) sits at y=0.511 of the image.
// ---------------------------------------------------------------------------

/** Where the ear pair's own base (bottom-centre, i.e. where it meets the
 * head) sits in the artwork, as a fraction of the image. Anchoring here
 * (rather than the sprite centre) is what lets the pair be pinned to a
 * single crown point the same way clownwignose.ts pins the wig to its face
 * hole, instead of floating disconnected from the head. */
const EAR_BASE_ANCHOR = { x: 0.5, y: 0.511 }

/** How wide the ear pair's visible content is, as a fraction of the image's
 * width. Used to convert a *desired visible width* (relative to ear-to-ear
 * distance) into the full sprite width PIXI needs to be told. */
const EAR_CONTENT_WIDTH_FRACTION = 0.831

/** Desired *visible* width of the ear pair, relative to ear-to-ear distance.
 * Slightly over 1 so the ears clear the sides of the head rather than
 * sitting narrower than it. Tune this if the ears look too big/small. */
const EAR_VISIBLE_SIZE_FACTOR = 1.15

/** How far above the nose the ear pair's base sits, in ear-to-ear distances
 * — same idea as batears.ts's CROWN_OFFSET_FACTOR. Tune this if the ears
 * sit too low/high on the head. */
const EAR_CROWN_OFFSET_FACTOR = 0.55

/** Nose position, ear-pair crown point, head scale and tilt from MP-33 pose
 * landmarks (nose=0, ears=7/8). Same sparse-face-point approach as
 * clownwignose.ts — there's no face-mesh detector in this pipeline, so the
 * face points already present in body pose are reused. The nose landmark is
 * what the snout is pinned to; the ears only supply scale, roll, and (via
 * EAR_CROWN_OFFSET_FACTOR) the ear pair's placement above the head. */
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
  // The nose itself must be solid — it's the anchor, so a weak detection
  // here would park the snout somewhere arbitrary on the face.
  if ((nose.visibility ?? 1) < 0.5) return undefined
  if ((leftEar.visibility ?? 1) < 0.3 && (rightEar.visibility ?? 1) < 0.3) return undefined

  const n = convertPoint(nose, height, width)
  const le = convertPoint(leftEar, height, width)
  const re = convertPoint(rightEar, height, width)

  const earDist = Math.hypot(le.x - re.x, le.y - re.y)
  if (earDist < 1) return undefined

  // Roll from the ear-to-ear line, so both pieces tilt with the head.
  const angle = Math.atan2(re.y - le.y, re.x - le.x)

  // "Up" is perpendicular to the ear line rather than screen-up, so the ear
  // pair stays on the head when it tilts instead of sliding off sideways —
  // same reasoning as clownwignose.ts's wig placement.
  const upX = Math.sin(angle)
  const upY = -Math.cos(angle)

  return {
    noseX: n.x,
    noseY: n.y,
    earX: n.x + upX * earDist * EAR_CROWN_OFFSET_FACTOR,
    earY: n.y + upY * earDist * EAR_CROWN_OFFSET_FACTOR,
    earDist,
    angle,
  }
}

export async function createPigNoseAnim(app: PIXI.Application) {
  const {
    renderer: { height, width },
    ticker,
    loader,
  } = app

  const container = new PIXI.Container()

  const [{ texture: noseTex }, { texture: earTex }] = await Promise.all([
    PIXI.ensureLoaded(loader, pigNoseImg),
    PIXI.ensureLoaded(loader, pigEarImg),
  ])

  // Ears added first so the snout draws on top, same ordering rationale as
  // clownwignose.ts's wig/nose (the pieces aren't expected to overlap, but
  // if they ever do the snout should win).
  const ears = PIXI.Sprite.from(earTex!)
  ears.anchor.set(EAR_BASE_ANCHOR.x, EAR_BASE_ANCHOR.y)
  container.addChild(ears)

  const nose = PIXI.Sprite.from(noseTex!)
  nose.anchor.set(0.5, 0.5)
  container.addChild(nose)

  // One filter per tracked quantity. The two pieces share the head's scale
  // and roll but track different points, so their positions are filtered
  // separately — deriving one from the other would make the ears lag the
  // nose (or vice versa) whenever the head moves quickly.
  const makeFilters = () => ({
    noseX: new KalmanFilter(KF_PARAMS),
    noseY: new KalmanFilter(KF_PARAMS),
    earX: new KalmanFilter(KF_PARAMS),
    earY: new KalmanFilter(KF_PARAMS),
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

  let noseX = 0
  let noseY = 0
  let earX = 0
  let earY = 0
  let earDist = 100
  let angle = 0
  const animManager = new AnimStateManager()

  const update = (pose: NormalizedLandmarkList) => {
    const target = getFaceTarget(pose, height, width)
    if (target) {
      const jumped =
        bound &&
        Math.hypot(target.noseX - noseX, target.noseY - noseY) >
          target.earDist * REBIND_SNAP_RATIO
      if (jumped || !bound) {
        // Fresh person for this slot: drop the old person's filter state so
        // the costume appears on them rather than travelling there.
        kf = makeFilters()
        bound = true
      }
      noseX = kf.noseX.filter(target.noseX)
      noseY = kf.noseY.filter(target.noseY)
      earX = kf.earX.filter(target.earX)
      earY = kf.earY.filter(target.earY)
      earDist = kf.size.filter(target.earDist)
      angle = kf.angle.filter(target.angle)
    }

    nose.width = nose.height = earDist * NOSE_SIZE_FACTOR
    ears.width = (earDist * EAR_VISIBLE_SIZE_FACTOR) / EAR_CONTENT_WIDTH_FRACTION
    ears.height = ears.width * (earTex!.height / earTex!.width)

    // Rotation is applied per sprite rather than to the container: rotating
    // the container would swing both pieces about a shared origin and pull
    // them off the face.
    nose.rotation = angle
    ears.rotation = angle

    animManager.tracking = !!target
    const { time, state } = animManager

    const place = () => {
      nose.position.set(noseX, noseY)
      ears.position.set(earX, earY)
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

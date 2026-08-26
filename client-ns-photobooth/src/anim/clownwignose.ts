import { NormalizedLandmarkList } from '@mediapipe/drawing_utils'
import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear } from './utils'
import { convertPoint } from '../api/nicepipe/mpPose'
import { AnimStateManager } from './AnimState'

import wigImg from '../assets/ClownWigNose/ClownWig.webp'
import noseImg from '../assets/ClownWigNose/ClownNose.png'

const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
  RETRACK: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
}

const KF_PARAMS = { R: 0.03, Q: 2 }

// ---------------------------------------------------------------------------
// Art geometry — measured from the source files' alpha channels, not guessed.
//
// The wig is a horseshoe with a hole for the face, so it can't be placed by
// its bounding box the way a solid sprite can: what has to line up with the
// head is the HOLE. Measuring where that hole sits in the artwork lets the
// sprite be anchored on it directly, so the tuning knobs below stay
// meaningful ("how wide is the wig relative to the head") instead of being
// opaque pixel nudges.
//
// ClownWig.webp is 1759x1265. Sampling its alpha row by row, the face opening
// runs from y=0.61 down to the bottom edge, spanning x 0.354..0.700 at ear
// height (y=0.80), i.e. centred at x=0.527 and 0.346 of the image wide.
//
// (The file arrived named ClownWig.jpg but is actually WebP — a JPEG cannot
// carry the alpha channel this needs. Renamed so the extension is honest.)
// ---------------------------------------------------------------------------

/** Where the face hole's centre sits in the wig artwork, as a fraction of the
 * image. This point is pinned to the middle of the head. */
const WIG_FACE_ANCHOR = { x: 0.527, y: 0.80 }

/** How wide the face hole is, as a fraction of the wig image's width. Used to
 * convert "the hole should be this big relative to the head" into the sprite
 * width PIXI needs to be told. */
const WIG_HOLE_WIDTH_FRACTION = 0.346

/** How wide the face hole should be relative to ear-to-ear distance. Slightly
 * under 1 so the wig sits close on the head rather than floating around it —
 * the hole only has to clear the skull, not the ears, since the wig sits over
 * them the way a real one does. Was 1.05, which made the whole wig too big.
 * This is the knob to turn if it sits too tight or too loose; everything else
 * scales from it. */
const WIG_HOLE_TO_HEAD_RATIO = 0.85

/** Nudge the wig up or down relative to the head, in ear-to-ear distances.
 * Positive moves it up. The hole is open-bottomed, so its measured "centre"
 * is only an approximation of where a head naturally sits inside it. */
const WIG_LIFT_FACTOR = 0.1

/** ClownNose.png is 447x447 with the ball spanning 0.141..0.857 — so the
 * visible nose is 0.716 of the canvas, the rest transparent margin. */
const NOSE_CONTENT_WIDTH_FRACTION = 0.716

/** Desired *visible* nose diameter relative to ear-to-ear distance. Well under
 * pignose.ts's 0.6, since a clown nose is a ball on the nose tip rather than a
 * whole snout. Was 0.38, reduced for the same reason as the wig. */
const NOSE_VISIBLE_SIZE_FACTOR = 0.30

// A jump larger than this (in ear-to-ear distances) means this animation slot
// has been handed to a different person, not that someone moved quickly. Snap
// to the new face rather than letting the filter drag the costume across the
// frame and over somebody else on the way. Same guard as clown.ts/pignose.ts.
const REBIND_SNAP_RATIO = 1.5

// The nose landmark anchors the costume, so a weak detection there would park
// it somewhere arbitrary. Ears only supply scale and roll, so one visible ear
// is enough to survive a profile turn.
const NOSE_VISIBILITY_MIN = 0.5
const EAR_VISIBILITY_MIN = 0.3

/** Nose position, head centre, scale and roll from MP-33 pose landmarks
 * (nose=0, ears=7/8). Same sparse-face-point approach as the other face props
 * — there is no face-mesh detector in this pipeline, so the face points
 * already present in body pose are reused. */
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

  // Roll from the ear-to-ear line, so both pieces tilt with the head.
  const angle = Math.atan2(re.y - le.y, re.x - le.x)

  // "Up" is perpendicular to the ear line rather than screen-up, so the wig
  // stays on the head when it tilts instead of sliding off sideways.
  const upX = Math.sin(angle)
  const upY = -Math.cos(angle)

  // Head centre is the ear midpoint — a better reference for the wig than the
  // nose, which sits forward of it and swings about as the head turns.
  const midX = (le.x + re.x) / 2
  const midY = (le.y + re.y) / 2

  return {
    noseX: n.x,
    noseY: n.y,
    wigX: midX + upX * earDist * WIG_LIFT_FACTOR,
    wigY: midY + upY * earDist * WIG_LIFT_FACTOR,
    earDist,
    angle,
  }
}

export async function createClownWigNoseAnim(app: PIXI.Application) {
  const {
    renderer: { height, width },
    ticker,
    loader,
  } = app

  const container = new PIXI.Container()

  const { texture: wigTex } = await PIXI.ensureLoaded(loader, wigImg)
  const { texture: noseTex } = await PIXI.ensureLoaded(loader, noseImg)

  // The wig is wider than it is tall, so its height must follow its width
  // rather than being set square — otherwise the artwork gets squashed.
  const wigAspect = wigTex!.height / wigTex!.width

  // Wig is added first so the nose draws on top: the wig's inner edge can
  // overlap the upper face, and the nose must never end up behind it.
  const wig = PIXI.Sprite.from(wigTex!)
  // Anchored on the face hole rather than the sprite centre — see
  // WIG_FACE_ANCHOR. This is what makes the head sit inside the wig instead
  // of behind it.
  wig.anchor.set(WIG_FACE_ANCHOR.x, WIG_FACE_ANCHOR.y)
  container.addChild(wig)

  const nose = PIXI.Sprite.from(noseTex!)
  nose.anchor.set(0.5, 0.5)
  container.addChild(nose)

  // One filter per tracked quantity. The two pieces share the head's scale and
  // roll but track different points, so their positions are filtered
  // separately — deriving one from the other would make the nose lag the wig
  // whenever the head moves quickly.
  const makeFilters = () => ({
    noseX: new KalmanFilter(KF_PARAMS),
    noseY: new KalmanFilter(KF_PARAMS),
    wigX: new KalmanFilter(KF_PARAMS),
    wigY: new KalmanFilter(KF_PARAMS),
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
  let wigX = 0
  let wigY = 0
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
        // Fresh person for this slot: drop the previous person's filter state
        // so the costume appears on them rather than travelling there.
        kf = makeFilters()
        bound = true
      }
      noseX = kf.noseX.filter(target.noseX)
      noseY = kf.noseY.filter(target.noseY)
      wigX = kf.wigX.filter(target.wigX)
      wigY = kf.wigY.filter(target.wigY)
      earDist = kf.size.filter(target.earDist)
      angle = kf.angle.filter(target.angle)
    }

    // Size the wig so its face hole matches the head, then let the rest of the
    // artwork follow from that.
    wig.width = (earDist * WIG_HOLE_TO_HEAD_RATIO) / WIG_HOLE_WIDTH_FRACTION
    wig.height = wig.width * wigAspect
    nose.width = nose.height =
      (earDist * NOSE_VISIBLE_SIZE_FACTOR) / NOSE_CONTENT_WIDTH_FRACTION

    // Rotation is applied per sprite rather than to the container: rotating
    // the container would swing both pieces about a shared origin and pull
    // them off the face.
    wig.rotation = angle
    nose.rotation = angle

    animManager.tracking = !!target
    const { time, state } = animManager

    const place = () => {
      wig.position.set(wigX, wigY)
      nose.position.set(noseX, noseY)
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

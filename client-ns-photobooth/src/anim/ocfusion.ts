import { NormalizedLandmarkList } from '../api/landmarks'
import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear } from './utils'
import { convertPoint } from '../api/nicepipe/mpPose'
import { AnimStateManager } from './AnimState'

import ocFusionImg from '../assets/OC_Fusion/oc_makeup.png'

// Was a hand-tracked hovering icon (WiLoR palm_up, same shape as drone.ts).
// Changed on request to replace the person's face instead — now the same
// sparse-face-point approach as clownwignose.ts/pignose.ts: no face-mesh
// detector in this pipeline, so the face points already present in body
// pose (nose=0, ears=7/8) are reused to size/position/rotate the image.
//
// Asset is oc_makeup.png (440x567, alpha-trimmed to content bbox
// (5,6)-(437,567)) — previously Firefly_RemoveBackground.png, before that
// the original abstract OC_FUSION.png logo. A photo needs its OWN eye-line
// lined up with the tracked head's, and it is nowhere near square — a
// centre-anchor + square-size approach would both misplace it (eyes
// wouldn't land where the real eyes are) and squash it toward square. See
// MASK_FACE_ANCHOR/MASK_CONTENT_WIDTH_FRACTION below, measured by eye
// against a percentage-gridded copy of the source file — re-measured for
// each asset swap, since these are photo-specific, not something that
// carries over from the previous image.
const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
  RETRACK: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
}

const KF_PARAMS = { R: 0.03, Q: 2 }

/** Where the eye-line sits in the source photo, as a fraction of the full
 * image — this point gets pinned to the tracked head's ear-midpoint, same
 * role as clownwignose's WIG_FACE_ANCHOR. Measured, not guessed: the
 * glasses/eyes sit right around 34% down the image, and the face reads as
 * horizontally centred. */
const MASK_FACE_ANCHOR = { x: 0.5, y: 0.34 }

/** How wide the face is at that eye-line (temple to temple, through the
 * glasses), as a fraction of the full image width — measured the same way
 * as clownwignose's WIG_HOLE_WIDTH_FRACTION, just against solid content
 * instead of a transparent hole. Used to convert "the face should be this
 * wide relative to ear-to-ear distance" into the sprite width PIXI needs. */
const MASK_CONTENT_WIDTH_FRACTION = 0.80

/** Desired *visible* face width relative to ear-to-ear distance. Starts near
 * 1 since this is a real face photo with real proportions — nudge this if
 * it reads too big/small once seen live. Carried over from the previous
 * asset's tuned value (they happened to share very similar framing/crop),
 * but re-check once seen live since it wasn't re-measured against this
 * specific photo. */
const FACE_COVER_SIZE_FACTOR = 1.1

/** Nudge the mask up relative to the tracked ear-midpoint, in ear-to-ear
 * distances, so the top of the head in the photo lines up with the real
 * hairline. Applied along the head's own "up" direction (perpendicular to
 * the ear line) rather than a flat screen-space offset, so it scales with
 * face size and stays correct as the head tilts — same approach as
 * batears.ts/pignose.ts's crown-offset lift. Carried over from the previous
 * asset's tuned value (0.3) as a starting point — tune further if it sits
 * too high/low on this photo specifically. */
const VERTICAL_LIFT_FACTOR = 0.3

// A jump larger than this (in ear-to-ear distances) means this animation
// slot has been handed to a different person, not that someone moved
// quickly. Snap to the new face rather than letting the filter drag the
// image across the frame and over somebody else on the way. Same guard as
// pignose.ts/clownwignose.ts.
const REBIND_SNAP_RATIO = 1.5

// The nose landmark anchors the mask, so a weak detection there would park
// it somewhere arbitrary. Ears only supply scale and roll, so one visible
// ear is enough to survive a profile turn.
const NOSE_VISIBILITY_MIN = 0.5
const EAR_VISIBILITY_MIN = 0.3

/** Face centre, scale and roll from MP-33 pose landmarks (nose=0, ears=7/8) —
 * same approach as clownwignose.ts's getFaceTarget. */
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

  const le = convertPoint(leftEar, height, width)
  const re = convertPoint(rightEar, height, width)

  const earDist = Math.hypot(le.x - re.x, le.y - re.y)
  if (earDist < 1) return undefined

  // Roll from the ear-to-ear line, so the mask tilts with the head.
  const angle = Math.atan2(re.y - le.y, re.x - le.x)

  // "Up" is perpendicular to the ear line rather than screen-up, so the
  // lift below stays correct as the head tilts instead of sliding off at
  // an angle — same convention as batears.ts/pignose.ts.
  const upX = Math.sin(angle)
  const upY = -Math.cos(angle)

  // Face centre is the ear midpoint — a steadier reference than the nose,
  // which sits forward of it and swings about as the head turns. Lifted up
  // slightly per VERTICAL_LIFT_FACTOR.
  const midX = (le.x + re.x) / 2 + upX * earDist * VERTICAL_LIFT_FACTOR
  const midY = (le.y + re.y) / 2 + upY * earDist * VERTICAL_LIFT_FACTOR

  return { x: midX, y: midY, earDist, angle }
}

export async function createOCFusionAnim(app: PIXI.Application) {
  const {
    renderer: { height, width },
    ticker,
    loader,
  } = app

  const container = new PIXI.Container()
  const { texture } = await PIXI.ensureLoaded(loader, ocFusionImg)

  // The photo is 440x567 — tall, not square. Height must follow width by
  // this aspect ratio rather than being set equal to it, or the face gets
  // squashed toward square every frame.
  const maskAspect = texture!.height / texture!.width

  const sprite = PIXI.Sprite.from(texture!)
  // Anchored on the measured eye-line (MASK_FACE_ANCHOR), not the sprite
  // centre — this is what lines the photo's own eyes up with the tracked
  // head's, the same role clownwignose's wig-hole anchor plays.
  sprite.anchor.set(MASK_FACE_ANCHOR.x, MASK_FACE_ANCHOR.y)
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
        // Fresh person for this slot: drop the previous person's filter
        // state so the mask appears on them rather than travelling there.
        kf = makeFilters()
        bound = true
      }
      x = kf.x.filter(target.x)
      y = kf.y.filter(target.y)
      earDist = kf.size.filter(target.earDist)
      angle = kf.angle.filter(target.angle)
    }

    // Size so the measured face width (MASK_CONTENT_WIDTH_FRACTION of the
    // image) matches the desired coverage, then derive height from the
    // image's own aspect ratio so it isn't squashed.
    sprite.width = (earDist * FACE_COVER_SIZE_FACTOR) / MASK_CONTENT_WIDTH_FRACTION
    sprite.height = sprite.width * maskAspect
    sprite.rotation = angle

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

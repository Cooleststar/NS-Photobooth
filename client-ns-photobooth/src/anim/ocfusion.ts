import { NormalizedLandmarkList } from '../api/landmarks'
import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear } from './utils'
import { convertPoint } from '../api/nicepipe/mpPose'
import { AnimStateManager } from './AnimState'

import ocFusionImg from '../assets/OC_Fusion/Firefly_RemoveBackground.png'

// Was a hand-tracked hovering icon (WiLoR palm_up, same shape as drone.ts).
// Changed on request to replace the person's face instead — now the same
// sparse-face-point approach as clownwignose.ts/pignose.ts: no face-mesh
// detector in this pipeline, so the face points already present in body
// pose (nose=0, ears=7/8) are reused to size/position/rotate the image.
//
// Asset is Firefly_RemoveBackground.png (912x1173, alpha-trimmed to content
// bbox (76,22)-(903,1173)) rather than the original abstract OC_FUSION.png
// logo. A photo needs its OWN eye-line lined up with the tracked head's, and
// it is nowhere near square — a centre-anchor + square-size approach would
// both misplace it (eyes wouldn't land where the real eyes are) and squash
// it toward square. See FIREFLY_FACE_ANCHOR/FIREFLY_CONTENT_WIDTH_FRACTION
// below, measured by eye against a percentage-gridded copy of the source
// file.
const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
  RETRACK: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
}

const KF_PARAMS = { R: 0.03, Q: 2 }

/** Where the eye-line sits in the source photo, as a fraction of the full
 * image — this point gets pinned to the tracked head's ear-midpoint, same
 * role as clownwignose's WIG_FACE_ANCHOR. Measured, not guessed: the glasses
 * sit right at ~38-39% down the image, and the face reads as horizontally
 * centred. */
const FIREFLY_FACE_ANCHOR = { x: 0.5, y: 0.385 }

/** How wide the face is at that eye-line (temple to temple, through the
 * glasses), as a fraction of the full image width — measured the same way
 * as clownwignose's WIG_HOLE_WIDTH_FRACTION, just against solid content
 * instead of a transparent hole. Used to convert "the face should be this
 * wide relative to ear-to-ear distance" into the sprite width PIXI needs. */
const FIREFLY_CONTENT_WIDTH_FRACTION = 0.80

/** Desired *visible* face width relative to ear-to-ear distance. Starts near
 * 1 since this is a real face photo with real proportions — nudge this if
 * it reads too big/small once seen live; the hair/tentacle effects extend
 * past the measured face width so a touch over 1 is expected to look
 * right. */
const FACE_COVER_SIZE_FACTOR = 1.1

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

  // Face centre is the ear midpoint — a steadier reference than the nose,
  // which sits forward of it and swings about as the head turns.
  const midX = (le.x + re.x) / 2
  const midY = (le.y + re.y) / 2

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

  // The photo is 912x1173 — tall, not square. Height must follow width by
  // this aspect ratio rather than being set equal to it, or the face gets
  // squashed toward square every frame.
  const fireflyAspect = texture!.height / texture!.width

  const sprite = PIXI.Sprite.from(texture!)
  // Anchored on the measured eye-line (FIREFLY_FACE_ANCHOR), not the sprite
  // centre — this is what lines the photo's own eyes up with the tracked
  // head's, the same role clownwignose's wig-hole anchor plays.
  sprite.anchor.set(FIREFLY_FACE_ANCHOR.x, FIREFLY_FACE_ANCHOR.y)
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

    // Size so the measured face width (FIREFLY_CONTENT_WIDTH_FRACTION of the
    // image) matches the desired coverage, then derive height from the
    // image's own aspect ratio so it isn't squashed.
    sprite.width = (earDist * FACE_COVER_SIZE_FACTOR) / FIREFLY_CONTENT_WIDTH_FRACTION
    sprite.height = sprite.width * fireflyAspect
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

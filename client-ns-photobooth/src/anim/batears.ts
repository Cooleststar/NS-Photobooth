import { NormalizedLandmarkList } from '@mediapipe/drawing_utils'
import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear } from './utils'
import { convertPoint } from '../api/nicepipe/mpPose'
import { AnimStateManager } from './AnimState'

import leftEarImg from '../assets/batears/leftear.png'
import rightEarImg from '../assets/batears/rightear.png'

const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
  RETRACK: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
}

const KF_PARAMS = { R: 0.03, Q: 2 }

// Earlier attempts anchored each ear directly to its own detected ear
// landmark (pose[7]/pose[8]) and tried to make the art wrap around the real
// ear. That landmark is noisy/awkwardly-placed for this purpose and kept
// producing bad results (gaps, one ear floating disconnected from the
// head). What actually looks right (per reference) is the same approach
// this file's horns used before they were removed: both ears positioned
// together at the top of the head, derived from the nose + ear-to-ear line
// (not tracking the ear landmarks' positions directly), like a headband —
// each source PNG's own visual center as the anchor (leftear.png content
// bbox center: x=92, y=142 of 496x503; rightear.png mirrors it), which
// keeps the art's own natural tilt intact instead of us guessing a
// rotation offset.
const LEFT_EAR_ANCHOR = { x: 0.1855, y: 0.2823 }
const RIGHT_EAR_ANCHOR = { x: 0.8145, y: 0.2823 }

// How much of the canvas's width the actual visible artwork occupies — used
// to convert a *desired visible size* (relative to ear-to-ear distance, an
// intuitive knob) into the full sprite width PIXI needs to be told (which
// includes the transparent margin). Computed from the source files.
const EAR_CONTENT_WIDTH_FRACTION = 0.3669

// Desired *visible* width of each ear, relative to ear-to-ear distance —
// the actual tuning knob. Was 0.8, reduced ~30% per feedback. Tune this if
// the ears look too small/large.
const EAR_VISIBLE_SIZE_FACTOR = 0.56

// Ears don't have their own reliable detected landmark to anchor to (see
// note above), so — same as this file's earlier horn logic — position is
// derived from the nose + ear-to-ear line: shifted up, then left/right
// along the ear line to spread the pair apart. Both as a fraction of
// ear-to-ear distance. CROWN_OFFSET_FACTOR at 0.2 (ear's own vertical
// center at eye level) put the ears overlapping the temples/cheekbones —
// reads as "ears growing out of the sides of the face" rather than sitting
// above the hairline like a natural cat/bat-ear look. Settled between that
// and the original crown/forehead height (0.7-1.05, reported as too high)
// — high enough to clear the hairline, lower than pure crown height. Tune
// this if the ears sit too low/high on the head, EAR_SPREAD_FACTOR if too
// close together/far apart.
const CROWN_OFFSET_FACTOR = 0.45
const EAR_SPREAD_FACTOR = 0.55

// Extra rotation on top of head-tilt — applying the same +40° to both ears
// last time only visibly rotated one of them, since they're mirror-image
// art: adding the same signed offset to both moves them toward opposite
// visual effects (one ear's tilt gets accentuated, the other's gets
// cancelled out toward upright). Mirrored here instead (+ on one ear, - on
// the other) so both rotate outward by the same amount. PIXI's rotation is
// clockwise-positive on screen (y grows downward).
const EAR_ROTATION_OFFSET = (40 * Math.PI) / 180

// A jump larger than this (in multiples of ear-to-ear distance) is not a
// person moving — it means this animation slot has been handed to a
// different person. Both ears reset their filters together when this
// fires (checked once, off the nose position), so one doesn't lag behind
// on the old person while the other has already snapped to the new one.
// Same reasoning as clown.ts/pignose.ts's REBIND_SNAP_RATIO.
const REBIND_SNAP_RATIO = 1.5

// Below this visibility on one ear while the other stays confidently
// visible means the head has turned into profile, not just noise — the
// occluded side's landmark doesn't disappear, the pose model just guesses a
// position for it (usually collapsed toward the visible ear or the nose),
// which otherwise shrinks earDist toward zero and drags both ears together
// into the middle of the face instead of one sitting properly at the
// visible ear's side.
const EAR_VISIBILITY_MIN = 0.3

interface PieceTarget { x: number; y: number; size: number; angle: number }

/** One ear sprite: its own Kalman-filtered position/size/angle, following
 * whatever target is passed to applyTarget() each frame. Fade lifecycle is
 * driven externally (shared between both ears via one AnimStateManager in
 * createBatEarsAnim) rather than each having its own, so they always
 * appear/disappear together as a single coherent prop. */
function createPiece(sprite: PIXI.Sprite, anchor: { x: number; y: number }) {
  sprite.anchor.set(anchor.x, anchor.y)

  const kf = {
    x: new KalmanFilter(KF_PARAMS),
    y: new KalmanFilter(KF_PARAMS),
    size: new KalmanFilter(KF_PARAMS),
    angle: new KalmanFilter(KF_PARAMS),
  }

  const resetFilters = () => {
    kf.x = new KalmanFilter(KF_PARAMS)
    kf.y = new KalmanFilter(KF_PARAMS)
    kf.size = new KalmanFilter(KF_PARAMS)
    kf.angle = new KalmanFilter(KF_PARAMS)
  }

  const applyTarget = (target: PieceTarget) => {
    const x = kf.x.filter(target.x)
    const y = kf.y.filter(target.y)
    const size = kf.size.filter(target.size)
    const angle = kf.angle.filter(target.angle)
    sprite.width = size / EAR_CONTENT_WIDTH_FRACTION
    sprite.height = sprite.width * (sprite.texture.height / sprite.texture.width)
    sprite.rotation = angle
    sprite.position.set(x, y)
  }

  return { sprite, resetFilters, applyTarget }
}

/** Nose, ear-to-ear geometry, and derived crown-left/crown-right points —
 * the basis both ears' targets are computed from. Same sparse-face-point
 * approach as clown.ts/pignose.ts: there's no dedicated face-mesh
 * detector in this pipeline, so the face points already present in body
 * pose (nose=0, ears=7/8) are reused — here only for scale/tilt, not as
 * the ears' own placement (see note at the top of this file). */
function getHeadGeometry(pose: NormalizedLandmarkList, height: number, width: number) {
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

  const dx = re.x - le.x
  const dy = re.y - le.y
  const earDist = Math.hypot(dx, dy)
  if (earDist < 1) return undefined

  const angle = Math.atan2(dy, dx)

  return {
    nose: n,
    earDist,
    angle,
    leftVisible: (leftEar.visibility ?? 1) >= EAR_VISIBILITY_MIN,
    rightVisible: (rightEar.visibility ?? 1) >= EAR_VISIBILITY_MIN,
  }
}

/** Crown points derived from a nose position plus an ear-to-ear
 * distance/angle — split out from getHeadGeometry so the caller can pass in
 * either the current (live) earDist/angle, or a frozen last-known-good pair
 * during a profile turn (see EAR_VISIBILITY_MIN above). */
function crownPointsFrom(nose: { x: number; y: number }, earDist: number, angle: number) {
  // Unit vectors along the ear-to-ear line ("right" along the head) and
  // perpendicular to it ("up", toward the top of the head) — both rotate
  // correctly with head tilt since they're derived from the same angle the
  // rest of the geometry uses.
  const rightX = Math.cos(angle)
  const rightY = Math.sin(angle)
  const upX = rightY
  const upY = -rightX

  const crownX = nose.x + upX * earDist * CROWN_OFFSET_FACTOR
  const crownY = nose.y + upY * earDist * CROWN_OFFSET_FACTOR
  const spread = earDist * EAR_SPREAD_FACTOR

  return {
    leftCrown: { x: crownX - rightX * spread, y: crownY - rightY * spread },
    rightCrown: { x: crownX + rightX * spread, y: crownY + rightY * spread },
  }
}

export async function createBatEarsAnim(app: PIXI.Application) {
  const {
    renderer: { height, width },
    ticker,
    loader,
  } = app

  const container = new PIXI.Container()
  const [leftEarTex, rightEarTex] = await Promise.all([
    PIXI.ensureLoaded(loader, leftEarImg).then((r) => r.texture!),
    PIXI.ensureLoaded(loader, rightEarImg).then((r) => r.texture!),
  ])

  const leftEar = createPiece(PIXI.Sprite.from(leftEarTex), LEFT_EAR_ANCHOR)
  const rightEar = createPiece(PIXI.Sprite.from(rightEarTex), RIGHT_EAR_ANCHOR)
  const pieces = [leftEar, rightEar]
  for (const p of pieces) container.addChild(p.sprite)

  // whether the filters currently hold a recent target belonging to this
  // same person (checked once via the nose, applied to both ears)
  let bound = false
  let lastNoseX = 0
  let lastNoseY = 0
  // Last earDist/angle read while roughly facing the camera (both ears
  // visible) — reused during a profile turn instead of the live (collapsed)
  // values, so the pair's size/rotation doesn't shrink toward the face.
  let lastGoodEarDist: number | undefined
  let lastGoodAngle: number | undefined

  const initialState = () => {
    container.alpha = 0
    bound = false
    lastGoodEarDist = undefined
    lastGoodAngle = undefined
    leftEar.sprite.alpha = rightEar.sprite.alpha = 1
  }
  initialState()

  const animManager = new AnimStateManager()

  const update = (pose: NormalizedLandmarkList) => {
    const geo = getHeadGeometry(pose, height, width)

    if (geo) {
      const jumped = bound && Math.hypot(geo.nose.x - lastNoseX, geo.nose.y - lastNoseY) > geo.earDist * REBIND_SNAP_RATIO
      if (jumped || !bound) {
        // Fresh person for this slot: discard both ears' filter state so
        // they appear on them rather than travelling there, and any frozen
        // profile-turn geometry from whoever had this slot before.
        for (const p of pieces) p.resetFilters()
        bound = true
        lastGoodEarDist = undefined
        lastGoodAngle = undefined
      }
      lastNoseX = geo.nose.x
      lastNoseY = geo.nose.y

      // Exactly one ear crossing the visibility threshold means the head's
      // turned into profile, not just noise on a mostly-frontal face.
      const profileTurn = geo.leftVisible !== geo.rightVisible
      if (!profileTurn) {
        lastGoodEarDist = geo.earDist
        lastGoodAngle = geo.angle
      }
      const earDist = (profileTurn && lastGoodEarDist !== undefined) ? lastGoodEarDist : geo.earDist
      const angle = (profileTurn && lastGoodAngle !== undefined) ? lastGoodAngle : geo.angle
      const { leftCrown, rightCrown } = crownPointsFrom(geo.nose, earDist, angle)

      leftEar.applyTarget({ x: leftCrown.x, y: leftCrown.y, size: earDist * EAR_VISIBLE_SIZE_FACTOR, angle: angle - EAR_ROTATION_OFFSET })
      rightEar.applyTarget({ x: rightCrown.x, y: rightCrown.y, size: earDist * EAR_VISIBLE_SIZE_FACTOR, angle: angle + EAR_ROTATION_OFFSET })

      // Hide whichever ear is actually occluded during a profile turn,
      // rather than rendering it collapsed near the visible one/the nose.
      leftEar.sprite.alpha = profileTurn && !geo.leftVisible ? 0 : 1
      rightEar.sprite.alpha = profileTurn && !geo.rightVisible ? 0 : 1
    }

    animManager.tracking = !!geo
    const { time, state } = animManager

    switch (state) {
      case 'exited':
        initialState()
        break

      case 'entering':
        container.alpha = lerpLinear(time, 0, ANIM.FADE)
        if (time >= ANIM.FADE) animManager.transition()
        break

      case 'entered':
        container.alpha = 1
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

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

// Each source PNG (496x503) is a single ear shape — pointed tip up-left
// (left ear) / up-right (right ear), tapering to a narrow *zero-width*
// point at the inner-bottom corner where it'd meet the head (leftear.png:
// x=183, y=152 of 496x503). Anchoring exactly at that point (an earlier
// attempt) put the ear's actual visible bulk noticeably away from the
// landmark — nothing has any width right at a zero-width tip — which
// showed up as a gap between the real ear and the start of the graphic,
// worse at larger sizes since that "dead zone" scales up too. Anchoring
// instead where the shape already has real width (traced the shape's
// thickness moving in from the tip; picked x=160, where it's ~57px thick,
// comparable to a real ear) puts substantial artwork immediately at the
// landmark, wrapping around the ear instead of floating beside it.
// rightear.png mirrors these. Found by inspecting the actual source art,
// not assumed from bounding-box math — see git history for earlier
// wrong guesses on this and the previous (different) source art.
const LEFT_EAR_ANCHOR = { x: 0.3226, y: 0.2674 }
const RIGHT_EAR_ANCHOR = { x: 0.6774, y: 0.2674 }

// How much of the canvas's width the actual visible artwork occupies — used
// to convert a *desired visible size* (relative to ear-to-ear distance, an
// intuitive knob) into the full sprite width PIXI needs to be told (which
// includes the transparent margin). Also computed from the source files.
const EAR_CONTENT_WIDTH_FRACTION = 0.3669

// Desired *visible* width of each ear, relative to ear-to-ear distance —
// the actual tuning knob. Was 0.85 — too large relative to a real head.
// Tune this if the ears look too small/large on a real face.
const EAR_VISIBLE_SIZE_FACTOR = 0.5

// Extra rotation on top of head-tilt, pivoting around the fixed anchor
// point (so the tip swings while the base stays put) — meant to angle the
// ear's base edge to sit flush against the head/hairline instead of
// leaving a gap below it. Mirrored between ears (each rotates toward the
// head, not the same direction) since they're mirror images of each other.
// A guess, not verified against a live camera — if the ears tilt the wrong
// way (gap gets worse, or they tip toward the face), flip the sign.
const EAR_TILT_OFFSET = 0.35 // ~20 degrees

// A jump larger than this (in multiples of ear-to-ear distance) is not a
// person moving — it means this animation slot has been handed to a
// different person. Both ears reset their filters together when this
// fires (checked once, off the nose position), so one doesn't lag behind
// on the old person while the other has already snapped to the new one.
// Same reasoning as pig.ts/clown.ts/pignose.ts's REBIND_SNAP_RATIO.
const REBIND_SNAP_RATIO = 1.5

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

/** Nose + ear-to-ear geometry — the basis each ear's target is computed
 * from. Same sparse-face-point approach as pig.ts/clown.ts/pignose.ts:
 * there's no dedicated face-mesh detector in this pipeline, so the face
 * points already present in body pose (nose=0, ears=7/8) are reused. */
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

  // Head tilt, from the ear-to-ear line — so the ears rotate with the head.
  const angle = Math.atan2(dy, dx)

  return {
    nose: n,
    leftEar: le,
    rightEar: re,
    // Each ear's own landmark can be individually unreliable even when the
    // other one (and the nose) is solid — most commonly a turned/profile
    // head, where the far ear is occluded. MediaPipe still returns *some*
    // coordinate for an occluded landmark (often wrong, e.g. landing on the
    // cheek/eye instead of the actual ear), so this has to be checked per
    // ear, not just "at least one ear is visible" as the early-return above
    // does — otherwise the ear for the unreliable side renders wherever
    // that bad guess happens to be, e.g. on the face, instead of being
    // hidden until that ear is actually visible again.
    leftEarVisible: (leftEar.visibility ?? 1) >= 0.5,
    rightEarVisible: (rightEar.visibility ?? 1) >= 0.5,
    earDist,
    angle,
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

  const initialState = () => {
    container.alpha = 0
    bound = false
  }
  initialState()

  const animManager = new AnimStateManager()

  const update = (pose: NormalizedLandmarkList) => {
    const geo = getHeadGeometry(pose, height, width)

    if (geo) {
      const jumped = bound && Math.hypot(geo.nose.x - lastNoseX, geo.nose.y - lastNoseY) > geo.earDist * REBIND_SNAP_RATIO
      if (jumped || !bound) {
        // Fresh person for this slot: discard both ears' filter state so
        // they appear on them rather than travelling there.
        for (const p of pieces) p.resetFilters()
        bound = true
      }
      lastNoseX = geo.nose.x
      lastNoseY = geo.nose.y

      // Hide (rather than reposition onto a bad guess) whichever ear's own
      // landmark isn't currently trustworthy — see the comment on
      // leftEarVisible/rightEarVisible in getHeadGeometry.
      leftEar.sprite.visible = geo.leftEarVisible
      rightEar.sprite.visible = geo.rightEarVisible
      if (geo.leftEarVisible) {
        leftEar.applyTarget({ x: geo.leftEar.x, y: geo.leftEar.y, size: geo.earDist * EAR_VISIBLE_SIZE_FACTOR, angle: geo.angle + EAR_TILT_OFFSET })
      }
      if (geo.rightEarVisible) {
        rightEar.applyTarget({ x: geo.rightEar.x, y: geo.rightEar.y, size: geo.earDist * EAR_VISIBLE_SIZE_FACTOR, angle: geo.angle - EAR_TILT_OFFSET })
      }
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

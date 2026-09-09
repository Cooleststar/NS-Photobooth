import { NormalizedLandmarkList } from '../api/landmarks'
import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear, lerpEO } from './utils'
import { convertPoint } from '../api/nicepipe/mpPose'
import { AnimStateManager } from './AnimState'

import globeGif from '../assets/globe_anim/globe.gif'

const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
  RETRACK: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
}

const KF_PARAMS = { R: 0.03, Q: 2 }

// One full revolution every half second. Screen y grows DOWNWARD, so a
// positive sin term on y sweeps right -> bottom -> left -> top as the angle
// increases, which reads as clockwise on screen.
const ORBIT_PERIOD_SEC = 0.5
const ORBIT_SPEED = (Math.PI * 2) / ORBIT_PERIOD_SEC

// A true circle. This was 0.5, which drew a flattened ellipse — that reads as
// an orbit tilted away into depth, i.e. one passing behind the head, and
// there's no person-segmentation mask in this pipeline to actually occlude
// the globe when it does. A round path in the screen plane reads as going
// *around* the head instead, which is the intent.
const ORBIT_Y_SQUISH = 1

// Orbit radius, in multiples of the globe's own size. Has to leave the
// globe's inner edge clear of the head, or it crosses the face rather than
// circling it. A head is roughly 0.45 of shoulder width and the globe 0.25
// (GLOBE_SIZE_FACTOR), so the head is ~1.8 globes wide: clearing it needs at
// least half the head (0.9) plus half the globe (0.5) = 1.4 here. 1.8 leaves
// a visible gap. Raise this for a wider ring.
const ORBIT_RADIUS_FACTOR = 1.8

// Globe size relative to shoulder width. Was 0.7, which made the globe about
// 1.5x wider than the head itself — at that size a ring around the head
// spans nearly two shoulder widths, runs off the top of the frame, and gets
// flattened by the clampPos() bounds instead of staying round. A quarter of
// shoulder width reads as a satellite circling the head.
const GLOBE_SIZE_FACTOR = 0.25

// Both offsets are fractions of SHOULDER width, not of ear-to-ear distance:
// ear separation collapses toward zero the moment someone turns their head,
// which would drag the orbit's center around mid-spin. Shoulder width holds
// steady through head rotation. The nose sits below the head's true center,
// and the head sits above the shoulder line.
const NOSE_TO_HEAD_CENTER = 0.1
const SHOULDER_TO_HEAD_CENTER = 0.55

const BOB_SPEED = 2.5
const BOB_AMPLITUDE = 0.08

interface FeedBounds { left: number; right: number; top: number; bottom: number }

function clampPos(x: number, y: number, size: number, b: FeedBounds) {
  const half = size * 0.5
  return {
    x: Math.max(b.left + half, Math.min(b.right - half, x)),
    y: Math.max(b.top + half, Math.min(b.bottom - half, y)),
  }
}

// ---------------------------------------------------------------------------
// Pose helpers
// ---------------------------------------------------------------------------

function getTorsoCenter(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
) {
  if (pose.length === 0) return undefined
  const ls = pose[11]
  const rs = pose[12]
  if (!ls || !rs || ls.visibility! < 0.5 || rs.visibility! < 0.5) return undefined
  const l = convertPoint(ls, height, width)
  const r = convertPoint(rs, height, width)
  return {
    x: (l.x + r.x) / 2,
    y: (l.y + r.y) / 2,
    shoulderWidth: Math.abs(l.x - r.x),
  }
}

function getHandsApart(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
) {
  if (pose.length === 0) return undefined
  const lw = pose[15]
  const rw = pose[16]
  const ls = pose[11]
  const rs = pose[12]
  if (!lw || !rw || !ls || !rs) return undefined
  if (lw.visibility! < 0.5 || rw.visibility! < 0.5) return undefined
  if (ls.visibility! < 0.5 || rs.visibility! < 0.5) return undefined

  const lwP = convertPoint(lw, height, width)
  const rwP = convertPoint(rw, height, width)
  const lsP = convertPoint(ls, height, width)
  const rsP = convertPoint(rs, height, width)

  const handDist = Math.abs(lwP.x - rwP.x)
  const shoulderWidth = Math.abs(lsP.x - rsP.x)

  // Hands must be wider than shoulders and at roughly chest level
  const avgWristY = (lwP.y + rwP.y) / 2
  const avgShoulderY = (lsP.y + rsP.y) / 2
  const chestLevel = avgWristY > avgShoulderY && avgWristY < avgShoulderY + shoulderWidth * 1.5

  if (handDist > shoulderWidth * 1.2 && chestLevel) {
    return {
      x: (lwP.x + rwP.x) / 2,
      y: (lwP.y + rwP.y) / 2,
      distance: handDist,
    }
  }
  return undefined
}

/** Center of the orbit: the head, falling back to a point above the shoulder
 * line when the face isn't detected.
 *
 * The fallback matters — the globe is triggered by the torso being visible
 * (see hasPerson below), so anchoring the orbit strictly to the face would
 * make it vanish the instant someone turned away from the camera. Same
 * nose/ear landmarks and same visibility thresholds every other
 * face-anchored character in this codebase uses; the ears are only read as a
 * "is this face actually facing us" signal, since the position itself comes
 * off the nose. */
function getHeadCenter(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
  torso: { x: number; y: number; shoulderWidth: number },
) {
  const nose = pose[0]
  const leftEar = pose[7]
  const rightEar = pose[8]
  const faceVisible =
    !!nose && !!leftEar && !!rightEar &&
    (nose.visibility ?? 1) >= 0.5 &&
    ((leftEar.visibility ?? 1) >= 0.3 || (rightEar.visibility ?? 1) >= 0.3)

  if (faceVisible) {
    const n = convertPoint(nose, height, width)
    return { x: n.x, y: n.y - torso.shoulderWidth * NOSE_TO_HEAD_CENTER }
  }
  return {
    x: torso.x,
    y: torso.y - torso.shoulderWidth * SHOULDER_TO_HEAD_CENTER,
  }
}

function calculateGlobeSize(shoulderWidth: number) {
  return Math.max(60, shoulderWidth * GLOBE_SIZE_FACTOR)
}

// ---------------------------------------------------------------------------
// Globe animation
// ---------------------------------------------------------------------------

export async function createGlobeAnim(
  app: PIXI.Application,
  margins = { mx: 30 / 1920, mt: 30 / 1080, mb: 30 / 1080 },
) {
  const {
    renderer: { height, width },
    ticker,
    loader,
  } = app

  const bounds: FeedBounds = {
    left: margins.mx * width,
    right: (1 - margins.mx) * width,
    top: margins.mt * height,
    bottom: (1 - margins.mb) * height,
  }

  const container = new PIXI.Container()
  const sprite = await PIXI.ensureLoaded(loader, globeGif).then((r) => r.animation!.clone())
  sprite.anchor.set(0.5, 0.5)
  container.addChild(sprite)

  const initialState = () => {
    container.alpha = 0
    container.position.set(0, 0)
    sprite.stop()
    sprite.alpha = 0
    sprite.currentFrame = 0
  }
  initialState()

  const kf = {
    x: new KalmanFilter(KF_PARAMS),
    y: new KalmanFilter(KF_PARAMS),
    size: new KalmanFilter(KF_PARAMS),
    handX: new KalmanFilter({ R: 0.02, Q: 3 }),
    handY: new KalmanFilter({ R: 0.02, Q: 3 }),
    handSize: new KalmanFilter({ R: 0.02, Q: 3 }),
  }

  let globeSize = 150
  let orbitAngle = 0
  let bobTime = 0
  let headX = 0
  let headY = 0
  const animManager = new AnimStateManager()

  // Modulo rather than a single subtraction: at 4π rad/s one stalled frame
  // can advance the angle by more than a full turn, which a lone `-= 2π`
  // would fail to wrap.
  const advanceOrbit = (dt: number) => {
    orbitAngle = (orbitAngle + dt * ORBIT_SPEED) % (Math.PI * 2)
  }

  /** Unclamped point on the orbit for the current angle — callers clamp.
   * Shared by every state that draws the orbit so they can't drift apart. */
  const orbitPoint = (bobOffset: number) => {
    const orbitR = globeSize * ORBIT_RADIUS_FACTOR
    return {
      x: headX + Math.cos(orbitAngle) * orbitR,
      y: headY + Math.sin(orbitAngle) * orbitR * ORBIT_Y_SQUISH + bobOffset,
    }
  }

  const update = (pose: NormalizedLandmarkList) => {
    const torso = getTorsoCenter(pose, height, width)
    const hands = getHandsApart(pose, height, width)
    const hasPerson = !!torso

    if (torso) {
      const head = getHeadCenter(pose, height, width, torso)
      headX = kf.x.filter(head.x)
      headY = kf.y.filter(head.y)
      globeSize = kf.size.filter(calculateGlobeSize(torso.shoulderWidth))
    }

    sprite.height = sprite.width = globeSize

    animManager.tracking = hasPerson
    const { time, state } = animManager

    switch (state) {
      case 'exited':
        initialState()
        orbitAngle = 0
        bobTime = 0
        break

      case 'entering': {
        container.alpha = 1
        if (!sprite.playing) sprite.play()
        sprite.alpha = lerpLinear(time, 0, ANIM.FADE)

        // Fly in toward the moving orbit point rather than the head's center,
        // so the globe joins the ring already in motion instead of landing at
        // the middle and popping outward when 'entered' takes over.
        advanceOrbit(ticker.deltaMS / 1000)
        const progress = lerpEO(time, 0, ANIM.FADE)
        const target = orbitPoint(0)
        const startX = headX + width * 0.3
        const startY = headY - height * 0.2
        const ep = clampPos(
          startX + (target.x - startX) * progress,
          startY + (target.y - startY) * progress,
          globeSize, bounds,
        )
        container.position.set(ep.x, ep.y)

        if (time >= ANIM.FADE) animManager.transition()
        break
      }

      case 'entered': {
        if (!sprite.playing) sprite.play()
        container.alpha = 1

        bobTime += ticker.deltaMS / 1000
        const bobOffset = Math.sin(bobTime * BOB_SPEED) * globeSize * BOB_AMPLITUDE

        if (hands) {
          // Between-hands mode: globe moves to midpoint, scales with distance
          sprite.alpha = 1
          const hx = kf.handX.filter(hands.x)
          const hy = kf.handY.filter(hands.y)
          const handGlobeSize = kf.handSize.filter(hands.distance * 0.4)
          sprite.height = sprite.width = handGlobeSize
          const hp = clampPos(hx, hy + bobOffset, handGlobeSize, bounds)
          container.position.set(hp.x, hp.y)
        } else {
          // Orbit mode: a full clockwise circle around the head, one turn
          // every ORBIT_PERIOD_SEC. This used to sweep only the front half
          // (angle held within [0, π)) around the torso instead, on the
          // reasoning that a back half with nothing to occlude it was dead
          // travel time — but the ring sits around the head now, in the
          // screen plane, so there is no "behind" to hide in and every part
          // of the circle is worth drawing.
          advanceOrbit(ticker.deltaMS / 1000)
          const p = orbitPoint(bobOffset)
          const op = clampPos(p.x, p.y, globeSize, bounds)
          container.position.set(op.x, op.y)
          sprite.alpha = 1
        }
        break
      }

      case 'lost': {
        // Keeps spinning on the last known head position through a brief
        // tracking dropout, so a lost frame doesn't stall the globe mid-arc.
        advanceOrbit(ticker.deltaMS / 1000)
        bobTime += ticker.deltaMS / 1000
        const bobOff = Math.sin(bobTime * BOB_SPEED) * globeSize * BOB_AMPLITUDE
        const p = orbitPoint(bobOff)
        const lp = clampPos(p.x, p.y, globeSize, bounds)
        container.position.set(lp.x, lp.y)
        sprite.alpha = 1
        if (time >= ANIM.RETRACK) animManager.transition()
        break
      }

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

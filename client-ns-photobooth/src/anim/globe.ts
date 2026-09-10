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
const ORBIT_SPEED = 0.8
const ORBIT_RADIUS_FACTOR = 0.9
const ORBIT_Y_SQUISH = 0.5

// The orbit runs as a full circle now, read as an ellipse tilted away from
// the camera. sin(angle) is the depth cue and drives everything below: +1 at
// the near point (lowest on screen, sweeping in front of the body), -1 at
// the far point (highest on screen, passing behind it).
//
// How much the globe grows toward the camera and shrinks away from it, as a
// fraction of its base size. This perspective change is what sells the path
// as a loop through depth rather than a flat arc across the body.
const DEPTH_SCALE = 0.25

// Depth at which the globe has faded out completely. It starts fading as it
// crosses the side of the body (depth 0), is fully gone by this much depth,
// and stays gone across the deepest part of the pass before easing back in
// on the other side.
//
// There's no person-segmentation mask in this pipeline, so "behind the body"
// has to be sold with opacity rather than real occlusion. This replaced a
// hard cut at a fixed angle followed by a timed absence, which read as the
// globe blinking out rather than travelling anywhere. At the default orbit
// speed the globe is fully hidden for roughly 2.5s with about 0.7s of fade
// at each end — raise this to shorten the hidden stretch and lengthen the
// fades, lower it for the reverse.
const BEHIND_FADE_DEPTH = 0.55
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

function calculateGlobeSize(shoulderWidth: number) {
  return Math.max(100, shoulderWidth * 0.7)
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
  let torsoX = 0
  let torsoY = 0
  const animManager = new AnimStateManager()

  const advanceOrbit = (dt: number) => {
    orbitAngle = (orbitAngle + dt * ORBIT_SPEED) % (Math.PI * 2)
  }

  /** Where the globe sits, how big it is and how solid it looks at the
   * current orbit angle. Shared by 'entered' and 'lost' so the two can't
   * drift apart. */
  const orbitFrame = (bobOffset: number) => {
    const depth = Math.sin(orbitAngle)
    const size = globeSize * (1 + DEPTH_SCALE * depth)
    const orbitR = globeSize * ORBIT_RADIUS_FACTOR
    const p = clampPos(
      torsoX + Math.cos(orbitAngle) * orbitR,
      torsoY + depth * orbitR * ORBIT_Y_SQUISH + bobOffset,
      size, bounds,
    )
    // Smoothstep over the clamped ramp: a bare linear fade leaves a visible
    // corner where it meets full opacity and full transparency, which is the
    // same kind of abruptness this is meant to get rid of.
    const t = lerpLinear(depth, -BEHIND_FADE_DEPTH, 0)
    return { x: p.x, y: p.y, size, alpha: t * t * (3 - 2 * t) }
  }

  const update = (pose: NormalizedLandmarkList) => {
    const torso = getTorsoCenter(pose, height, width)
    const hands = getHandsApart(pose, height, width)
    const hasPerson = !!torso

    if (torso) {
      torsoX = kf.x.filter(torso.x)
      torsoY = kf.y.filter(torso.y)
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

        const progress = lerpEO(time, 0, ANIM.FADE)
        const startX = torsoX + width * 0.3
        const startY = torsoY - height * 0.2
        const ep = clampPos(
          startX + (torsoX - startX) * progress,
          startY + (torsoY - startY) * progress,
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
          // Orbit mode: a continuous circle around the torso. It swells as
          // it comes toward the camera across the front, then shrinks and
          // dissolves as it rounds the far side — see DEPTH_SCALE and
          // BEHIND_FADE_DEPTH.
          advanceOrbit(ticker.deltaMS / 1000)
          const f = orbitFrame(bobOffset)
          sprite.height = sprite.width = f.size
          sprite.alpha = f.alpha
          container.position.set(f.x, f.y)
        }
        break
      }

      case 'lost': {
        advanceOrbit(ticker.deltaMS / 1000)
        bobTime += ticker.deltaMS / 1000
        const bobOff = Math.sin(bobTime * BOB_SPEED) * globeSize * BOB_AMPLITUDE
        const f = orbitFrame(bobOff)
        sprite.height = sprite.width = f.size
        sprite.alpha = f.alpha
        container.position.set(f.x, f.y)
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

import { NormalizedLandmarkList } from '@mediapipe/drawing_utils'
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
        sprite.alpha = 1
        container.alpha = 1

        bobTime += ticker.deltaMS / 1000
        const bobOffset = Math.sin(bobTime * BOB_SPEED) * globeSize * BOB_AMPLITUDE

        if (hands) {
          // Between-hands mode: globe moves to midpoint, scales with distance
          const hx = kf.handX.filter(hands.x)
          const hy = kf.handY.filter(hands.y)
          const handGlobeSize = kf.handSize.filter(hands.distance * 0.4)
          sprite.height = sprite.width = handGlobeSize
          const hp = clampPos(hx, hy + bobOffset, handGlobeSize, bounds)
          container.position.set(hp.x, hp.y)
        } else {
          // Orbit mode: circle around torso
          orbitAngle += ticker.deltaMS / 1000 * ORBIT_SPEED
          const orbitR = globeSize * ORBIT_RADIUS_FACTOR
          const op = clampPos(
            torsoX + Math.cos(orbitAngle) * orbitR,
            torsoY + Math.sin(orbitAngle) * orbitR * ORBIT_Y_SQUISH + bobOffset,
            globeSize, bounds,
          )
          container.position.set(op.x, op.y)
        }
        break
      }

      case 'lost':
        orbitAngle += ticker.deltaMS / 1000 * ORBIT_SPEED
        bobTime += ticker.deltaMS / 1000
        const bobOff = Math.sin(bobTime * BOB_SPEED) * globeSize * BOB_AMPLITUDE
        const orbitR = globeSize * ORBIT_RADIUS_FACTOR
        const lp = clampPos(
          torsoX + Math.cos(orbitAngle) * orbitR,
          torsoY + Math.sin(orbitAngle) * orbitR * ORBIT_Y_SQUISH + bobOff,
          globeSize, bounds,
        )
        container.position.set(lp.x, lp.y)
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

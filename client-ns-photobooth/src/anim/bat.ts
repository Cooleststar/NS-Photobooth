import { NormalizedLandmarkList } from '@mediapipe/drawing_utils'
import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear, lerpEO } from './utils'
import { convertPoint } from '../api/nicepipe/mpPose'
import { AnimStateManager } from './AnimState'

import batFlyGif from '../assets/Bat_anim/Bat.gif'
import batSwoopGif from '../assets/Bat_anim/bat_swoop.gif'
import batVanishGif from '../assets/Bat_anim/bat_vanish.gif'

const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
  RETRACK: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
}

const KF_PARAMS = { R: 0.03, Q: 2 }
const ORBIT_SPEED = 1.8
const ORBIT_RADIUS_FACTOR = 0.6
const ORBIT_Y_SQUISH = 0.45
const SCARY_HOLD_TIME = 1.5

// ---------------------------------------------------------------------------
// Pose analysis
// ---------------------------------------------------------------------------

type PoseResult =
  | { type: 'none' }
  | { type: 'orbit'; headX: number; headY: number }
  | { type: 'hang'; wristX: number; wristY: number; headX: number; headY: number }
  | { type: 'scary'; headX: number; headY: number }

function analyzePose(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
): PoseResult {
  if (pose.length === 0) return { type: 'none' }

  const nose = pose[0]
  if (!nose || nose.visibility! < 0.5) return { type: 'none' }

  const head = convertPoint(nose, height, width)
  const headX = head.x
  const headY = head.y - height * 0.06

  const ls = convertPoint(pose[11], height, width)
  const rs = convertPoint(pose[12], height, width)
  const lw = convertPoint(pose[15], height, width)
  const rw = convertPoint(pose[16], height, width)

  const leftVis = pose[15].visibility! > 0.5 && pose[11].visibility! > 0.5
  const rightVis = pose[16].visibility! > 0.5 && pose[12].visibility! > 0.5
  const leftRaised = leftVis && lw.y < ls.y
  const rightRaised = rightVis && rw.y < rs.y

  if (leftRaised && rightRaised) {
    return { type: 'scary', headX, headY }
  }
  if (leftRaised) {
    return { type: 'hang', wristX: lw.x, wristY: lw.y, headX, headY }
  }
  if (rightRaised) {
    return { type: 'hang', wristX: rw.x, wristY: rw.y, headX, headY }
  }
  return { type: 'orbit', headX, headY }
}

function calculateBatSize(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
) {
  const leftEar = pose[7]
  const rightEar = pose[8]
  if (!leftEar || !rightEar) return 200
  const x1 = convertPoint(leftEar, height, width).x
  const x2 = convertPoint(rightEar, height, width).x
  return Math.max(150, Math.abs(x2 - x1) * 2.5)
}

// ---------------------------------------------------------------------------
// Swarm bat (corner bat for scary pose)
// ---------------------------------------------------------------------------

async function createSwarmBat(
  app: PIXI.Application,
  startX: number,
  startY: number,
  orbitOffset: number,
  orbitSpeedMul: number,
) {
  const { ticker, loader } = app
  const container = new PIXI.Container()

  const [flySprite, swoopSprite] = await Promise.all([
    PIXI.ensureLoaded(loader, batFlyGif).then((r) => r.animation!.clone()),
    PIXI.ensureLoaded(loader, batSwoopGif).then((r) => r.animation!.clone()),
  ])

  flySprite.anchor.set(0.5, 0.5)
  swoopSprite.anchor.set(0.5, 0.5)
  container.addChild(flySprite, swoopSprite)
  container.alpha = 0

  const swoopDuration = swoopSprite.duration / 1000
  let phase: 'hidden' | 'swooping' | 'flying' = 'hidden'
  let elapsed = 0
  let orbitAngle = orbitOffset
  let targetX = 0
  let targetY = 0
  let batSize = 200

  const reset = () => {
    container.alpha = 0
    flySprite.alpha = swoopSprite.alpha = 0
    flySprite.stop()
    swoopSprite.stop()
    flySprite.currentFrame = swoopSprite.currentFrame = 0
    phase = 'hidden'
    elapsed = 0
  }
  reset()

  const update = (scaryActive: boolean, headX: number, headY: number, size: number) => {
    targetX = headX
    targetY = headY
    batSize = size
    const orbitR = batSize * ORBIT_RADIUS_FACTOR * 1.3

    flySprite.height = flySprite.width = swoopSprite.height = swoopSprite.width = batSize * 0.8

    if (scaryActive && phase === 'hidden') {
      phase = 'swooping'
      elapsed = 0
      swoopSprite.currentFrame = 0
    }

    if (!scaryActive && phase !== 'hidden') {
      reset()
      return
    }

    if (phase === 'hidden') return

    elapsed += ticker.deltaMS / 1000

    if (phase === 'swooping') {
      container.alpha = 1
      if (!swoopSprite.playing) swoopSprite.play()
      swoopSprite.alpha = 1
      flySprite.alpha = 0

      const progress = lerpEO(elapsed, 0, swoopDuration)
      container.position.set(
        startX + (targetX - startX) * progress,
        startY + (targetY - startY) * progress,
      )

      if (elapsed >= swoopDuration) phase = 'flying'
    } else {
      swoopSprite.alpha = 0
      if (!flySprite.playing) flySprite.play()
      flySprite.alpha = 1
      container.alpha = 1

      orbitAngle += ticker.deltaMS / 1000 * ORBIT_SPEED * orbitSpeedMul
      container.position.set(
        targetX + Math.cos(orbitAngle) * orbitR,
        targetY + Math.sin(orbitAngle) * orbitR * ORBIT_Y_SQUISH,
      )
    }
  }

  return { container, update, reset }
}

// ---------------------------------------------------------------------------
// Main bat animation
// ---------------------------------------------------------------------------

export async function createBatAnim(app: PIXI.Application) {
  const {
    renderer: { height, width },
    ticker,
    loader,
  } = app

  const parentContainer = new PIXI.Container()

  // --- Main bat ---
  const mainContainer = new PIXI.Container()
  const [flySprite, swoopSprite, vanishSprite] = await Promise.all([
    PIXI.ensureLoaded(loader, batFlyGif).then((r) => r.animation!.clone()),
    PIXI.ensureLoaded(loader, batSwoopGif).then((r) => r.animation!.clone()),
    PIXI.ensureLoaded(loader, batVanishGif).then((r) => r.animation!.clone()),
  ])

  flySprite.anchor.set(0.5, 0.5)
  swoopSprite.anchor.set(0.5, 0.5)
  vanishSprite.anchor.set(0.5, 0.5)
  mainContainer.addChild(flySprite, swoopSprite, vanishSprite)
  parentContainer.addChild(mainContainer)

  // --- Swarm bats ---
  const cornerDefs = [
    { x: 0,     y: 0,      offset: 0,              speed: 1.1 },
    { x: width, y: 0,      offset: Math.PI * 0.5,  speed: 0.9 },
    { x: 0,     y: height, offset: Math.PI,         speed: 1.3 },
    { x: width, y: height, offset: Math.PI * 1.5,   speed: 0.7 },
  ]
  const swarmBats = await Promise.all(
    cornerDefs.map((c) => createSwarmBat(app, c.x, c.y, c.offset, c.speed))
  )
  swarmBats.forEach((s) => parentContainer.addChild(s.container))

  // --- State ---
  const initialState = () => {
    mainContainer.alpha = 0
    mainContainer.position.set(0, 0)
    mainContainer.scale.set(1, 1)
    flySprite.stop()
    swoopSprite.stop()
    vanishSprite.stop()
    flySprite.alpha = swoopSprite.alpha = vanishSprite.alpha = 0
    flySprite.currentFrame = swoopSprite.currentFrame = vanishSprite.currentFrame = 0
  }
  initialState()

  const kf = {
    x: new KalmanFilter(KF_PARAMS),
    y: new KalmanFilter(KF_PARAMS),
    size: new KalmanFilter(KF_PARAMS),
    hangX: new KalmanFilter({ R: 0.02, Q: 3 }),
    hangY: new KalmanFilter({ R: 0.02, Q: 3 }),
  }

  const swoopDuration = swoopSprite.duration / 1000
  const vanishDuration = vanishSprite.duration / 1000
  let batSize = 200
  let orbitAngle = 0
  let headX = 0
  let headY = 0

  // Hysteresis: once scary is detected, hold it for SCARY_HOLD_TIME even if
  // detection flickers. This prevents the swarm from rapidly vanishing/reappearing.
  let scaryActive = false
  let scaryLostTimer = 0

  const animManager = new AnimStateManager()

  const update = (pose: NormalizedLandmarkList) => {
    const poseResult = analyzePose(pose, height, width)
    const hasPerson = poseResult.type !== 'none'
    const rawScary = poseResult.type === 'scary'
    const isHang = poseResult.type === 'hang'

    // Scary hysteresis
    if (rawScary) {
      scaryActive = true
      scaryLostTimer = 0
    } else if (scaryActive) {
      scaryLostTimer += ticker.deltaMS / 1000
      if (scaryLostTimer >= SCARY_HOLD_TIME) {
        scaryActive = false
      }
    }

    if (hasPerson && 'headX' in poseResult) {
      headX = kf.x.filter(poseResult.headX)
      headY = kf.y.filter(poseResult.headY)
      batSize = kf.size.filter(calculateBatSize(pose, height, width))
    }

    const orbitR = batSize * ORBIT_RADIUS_FACTOR

    flySprite.height = flySprite.width =
      swoopSprite.height = swoopSprite.width =
      vanishSprite.height = vanishSprite.width =
        batSize

    // --- Swarm bats ---
    for (const sb of swarmBats) {
      sb.update(scaryActive, headX, headY, batSize)
    }

    // --- Main bat state machine ---
    animManager.tracking = hasPerson
    const { time, state } = animManager

    switch (state) {
      case 'exited':
        initialState()
        orbitAngle = 0
        scaryActive = false
        scaryLostTimer = 0
        for (const sb of swarmBats) sb.reset()
        break

      case 'entering': {
        mainContainer.alpha = 1
        mainContainer.scale.set(1, 1)
        if (!swoopSprite.playing) swoopSprite.play()
        swoopSprite.alpha = 1
        flySprite.alpha = 0
        vanishSprite.alpha = 0

        const progress = lerpEO(time, 0, swoopDuration)
        const swoopStartX = headX + width * 0.4
        const swoopStartY = headY - height * 0.3
        mainContainer.position.set(
          swoopStartX + (headX - swoopStartX) * progress,
          swoopStartY + (headY - swoopStartY) * progress,
        )

        if (time >= swoopDuration) animManager.transition()
        break
      }

      case 'entered':
        swoopSprite.alpha = 0
        vanishSprite.alpha = 0

        if (scaryActive) {
          // Hide main bat during scary pose — swarm bats take over
          mainContainer.alpha = 0
          flySprite.stop()
        } else if (isHang && poseResult.type === 'hang') {
          mainContainer.alpha = 1
          if (!flySprite.playing) flySprite.play()
          flySprite.alpha = 1
          const wx = kf.hangX.filter(poseResult.wristX)
          const wy = kf.hangY.filter(poseResult.wristY)
          mainContainer.position.set(wx, wy + batSize * 0.3)
          mainContainer.scale.set(1, -1)
        } else {
          mainContainer.alpha = 1
          mainContainer.scale.set(1, 1)
          if (!flySprite.playing) flySprite.play()
          flySprite.alpha = 1
          orbitAngle += ticker.deltaMS / 1000 * ORBIT_SPEED
          mainContainer.position.set(
            headX + Math.cos(orbitAngle) * orbitR,
            headY + Math.sin(orbitAngle) * orbitR * ORBIT_Y_SQUISH,
          )
        }
        break

      case 'lost':
        mainContainer.scale.set(1, 1)
        mainContainer.alpha = 1
        orbitAngle += ticker.deltaMS / 1000 * ORBIT_SPEED
        mainContainer.position.set(
          headX + Math.cos(orbitAngle) * orbitR,
          headY + Math.sin(orbitAngle) * orbitR * ORBIT_Y_SQUISH,
        )
        for (const sb of swarmBats) sb.reset()
        scaryActive = false
        if (time >= ANIM.RETRACK) animManager.transition()
        break

      case 'exiting':
        flySprite.alpha = 0
        swoopSprite.alpha = 0
        mainContainer.scale.set(1, 1)
        if (!vanishSprite.playing) vanishSprite.play()
        vanishSprite.alpha = 1
        for (const sb of swarmBats) sb.reset()
        scaryActive = false

        if (time < vanishDuration) {
          mainContainer.alpha = 1 - lerpLinear(time, vanishDuration * 0.5, vanishDuration)
        } else {
          initialState()
          animManager.transition()
        }
        break
    }

    animManager.update(ticker.deltaMS / 1000)
  }

  return [parentContainer, update] as const
}

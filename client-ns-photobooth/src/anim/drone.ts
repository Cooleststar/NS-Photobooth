import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear, lerpEO } from './utils'
import { AnimStateManager } from './AnimState'
import { HandData } from '../api/nicepipe'

import droneGif from '../assets/drone_anim/drone.gif'

const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
  RETRACK: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
}

const KF_PARAMS = { R: 0.02, Q: 1.5 }
const DRONE_SIZE_FACTOR = 0.22
const BOB_SPEED = 2.5
const BOB_AMPLITUDE_FACTOR = 0.014
const PALM_HOLD_TIME = 0.08

interface FeedBounds { left: number; right: number; top: number; bottom: number }

function clampPos(x: number, y: number, size: number, b: FeedBounds) {
  const half = size * 0.5
  return {
    x: Math.max(b.left + half, Math.min(b.right - half, x)),
    y: Math.max(b.top + half, Math.min(b.bottom - half, y)),
  }
}

// Assign palm-up hand screen positions to drone slots by proximity.
// Each slot claims the nearest unclaimed hand, so drones stick to the
// hand they are already near rather than swapping when sort order jitters.
function assignHandsToDrones(
  hands: HandData[],
  trackedPositions: Array<{ x: number; y: number }>,
  height: number,
  width: number,
): Array<{ x: number; y: number } | undefined> {
  const available = hands
    .filter(h => h.palmUp)
    .map(h => ({ x: (1 - h.x[0]) * width, y: h.y[0] * height }))

  const result: Array<{ x: number; y: number } | undefined> = trackedPositions.map(() => undefined)
  const claimed = new Set<number>()

  for (let i = 0; i < trackedPositions.length; i++) {
    const pos = trackedPositions[i]
    let bestDist = Infinity
    let bestIdx = -1
    for (let j = 0; j < available.length; j++) {
      if (claimed.has(j)) continue
      const d = Math.hypot(available[j].x - pos.x, available[j].y - pos.y)
      if (d < bestDist) { bestDist = d; bestIdx = j }
    }
    if (bestIdx >= 0) { result[i] = available[bestIdx]; claimed.add(bestIdx) }
  }
  return result
}

async function createHandDrone(
  app: PIXI.Application,
  droneSize: number,
  hoverOffset: number,
  bobAmplitude: number,
  bounds: FeedBounds,
) {
  const { height, width } = app.renderer
  const { ticker, loader } = app

  const container = new PIXI.Container()
  const sprite = await PIXI.ensureLoaded(loader, droneGif).then((r) => r.animation!.clone())
  sprite.anchor.set(0.5, 0.5)
  sprite.width = droneSize
  sprite.height = droneSize
  container.addChild(sprite)

  const initialState = () => {
    container.alpha = 0
    sprite.stop()
    sprite.currentFrame = 0
  }
  initialState()

  const kf = {
    x: new KalmanFilter(KF_PARAMS),
    y: new KalmanFilter(KF_PARAMS),
  }

  let wristX = 0
  let wristY = 0
  let bobTime = 0
  let palmHoldTimer = 0
  const animManager = new AnimStateManager()

  // Expose tracked position so the parent can use it for proximity-based assignment
  const getTrackedPos = () => ({ x: wristX, y: wristY })

  const update = (rawWrist: { x: number; y: number } | undefined) => {
    if (rawWrist) {
      palmHoldTimer = PALM_HOLD_TIME
      wristX = kf.x.filter(rawWrist.x)
      wristY = kf.y.filter(rawWrist.y)
    } else {
      palmHoldTimer = Math.max(0, palmHoldTimer - ticker.deltaMS / 1000)
    }

    const hasPerson = rawWrist !== undefined || palmHoldTimer > 0

    animManager.tracking = hasPerson
    const { time, state } = animManager

    const targetY = wristY - hoverOffset

    switch (state) {
      case 'exited':
        initialState()
        bobTime = 0
        break

      case 'entering': {
        container.alpha = 1
        if (!sprite.playing) sprite.play()
        sprite.alpha = lerpLinear(time, 0, ANIM.FADE)
        const progress = lerpEO(time, 0, ANIM.FADE)
        const startY = targetY - height * 0.2
        const ep = clampPos(wristX, startY + (targetY - startY) * progress, droneSize, bounds)
        container.position.set(ep.x, ep.y)
        if (time >= ANIM.FADE) animManager.transition()
        break
      }

      case 'entered': {
        if (!sprite.playing) sprite.play()
        sprite.alpha = 1
        container.alpha = 1
        bobTime += ticker.deltaMS / 1000
        const bob = Math.sin(bobTime * BOB_SPEED) * bobAmplitude
        const tp = clampPos(wristX, targetY + bob, droneSize, bounds)
        container.position.set(tp.x, tp.y)
        break
      }

      case 'lost': {
        // Transition out immediately — no re-track grace period for the drone
        animManager.transition()
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

  return [container, update, getTrackedPos] as const
}

export async function createDroneAnim(
  app: PIXI.Application,
  margins = { mx: 30 / 1920, mt: 30 / 1080, mb: 30 / 1080 },
) {
  const { height, width } = app.renderer

  const bounds: FeedBounds = {
    left: margins.mx * width,
    right: (1 - margins.mx) * width,
    top: margins.mt * height,
    bottom: (1 - margins.mb) * height,
  }

  const droneSize = height * DRONE_SIZE_FACTOR
  const hoverOffset = droneSize
  const bobAmplitude = height * BOB_AMPLITUDE_FACTOR

  const [container0, update0, getPos0] = await createHandDrone(app, droneSize, hoverOffset, bobAmplitude, bounds)
  const [container1, update1, getPos1] = await createHandDrone(app, droneSize, hoverOffset, bobAmplitude, bounds)

  const parentContainer = new PIXI.Container()
  parentContainer.addChild(container0)
  parentContainer.addChild(container1)

  const update = (hands: HandData[]) => {
    const [wrist0, wrist1] = assignHandsToDrones(hands, [getPos0(), getPos1()], height, width)
    update0(wrist0)
    update1(wrist1)
  }

  return [parentContainer, update] as const
}

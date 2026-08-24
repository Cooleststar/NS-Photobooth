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
// Grace period once already tracking, to tolerate brief single-frame gaps
// from detection jitter without instantly vanishing. Was 0.08s (~1-2
// frames at 25fps) — far too short to survive normal detection flicker.
const PALM_HOLD_TIME = 0.4
// How long the palm-facing-sky gesture must be continuously detected before
// the drone first triggers. Without this, a single misclassified frame
// during ordinary hand movement (adjusting hair, gesturing) could summon
// the drone with no intentional gesture at all. Trades a bit of trigger
// latency for not firing on noise — tune down if it feels sluggish, up if
// still trigger-happy.
const PALM_CONFIRM_TIME = 0.15

interface FeedBounds { left: number; right: number; top: number; bottom: number }

function clampPos(x: number, y: number, size: number, b: FeedBounds) {
  const half = size * 0.5
  return {
    x: Math.max(b.left + half, Math.min(b.right - half, x)),
    y: Math.max(b.top + half, Math.min(b.bottom - half, y)),
  }
}

// Landmark indices for the wrist + the four finger MCP (knuckle) joints —
// their average approximates the center of the palm regardless of hand
// orientation, unlike the wrist alone (which only worked as a stand-in for
// "below the fingertips" when the hand was held upright).
const PALM_LANDMARKS = [0, 5, 9, 13, 17]

function palmCenter(h: HandData, height: number, width: number) {
  let x = 0, y = 0
  for (const i of PALM_LANDMARKS) { x += h.x[i]; y += h.y[i] }
  x /= PALM_LANDMARKS.length
  y /= PALM_LANDMARKS.length
  return { x: (1 - x) * width, y: y * height }
}

// Assign palm-facing-sky hand screen positions to drone slots by proximity.
// Each slot claims the nearest unclaimed hand, so drones stick to the
// hand they are already near rather than swapping when sort order jitters.
function assignHandsToDrones(
  hands: HandData[],
  trackedPositions: Array<{ x: number; y: number }>,
  height: number,
  width: number,
): Array<{ x: number; y: number } | undefined> {
  const available = hands
    .filter(h => h.palmSky)
    .map(h => palmCenter(h, height, width))

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
  let palmConfirmTimer = 0
  const animManager = new AnimStateManager()

  // Expose tracked position so the parent can use it for proximity-based assignment
  const getTrackedPos = () => ({ x: wristX, y: wristY })

  const update = (rawWrist: { x: number; y: number } | undefined) => {
    if (rawWrist) {
      palmHoldTimer = PALM_HOLD_TIME
      palmConfirmTimer = Math.min(PALM_CONFIRM_TIME, palmConfirmTimer + ticker.deltaMS / 1000)
      wristX = kf.x.filter(rawWrist.x)
      wristY = kf.y.filter(rawWrist.y)
    } else {
      palmHoldTimer = Math.max(0, palmHoldTimer - ticker.deltaMS / 1000)
      // Reset on any gap — confirmation must be one continuous detection,
      // not accumulated flickers, otherwise this stops filtering noise.
      palmConfirmTimer = 0
    }

    // Already-tracking: tolerate brief gaps via the hold timer, no need to
    // re-confirm every tiny flicker. Not yet tracking: require the full
    // confirm duration first, so a single stray frame can't trigger it.
    const hasPerson = animManager.tracking
      ? rawWrist !== undefined || palmHoldTimer > 0
      : palmConfirmTimer >= PALM_CONFIRM_TIME

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
  // Sprite anchor is centered (0.5, 0.5), so offsetting by half its height
  // puts the drone's bottom edge right at palm height — reads as "resting
  // on top of the palm" rather than hovering high above it. Was a full
  // droneSize offset, appropriate for the old upright-palm/fingertip
  // gesture but way too high for a flat outstretched palm.
  const hoverOffset = droneSize * 0.45
  const bobAmplitude = height * BOB_AMPLITUDE_FACTOR

  // DRONE_SLOTS matches the backend's MediaPipe num_hands=4 — that's the
  // actual ceiling on simultaneous drones (e.g. up to 4 people showing one
  // palm each, or 2 people showing both). Raising this without also raising
  // num_hands in backend/main.py would just starve the extra slots of data.
  const DRONE_SLOTS = 4
  const drones = await Promise.all(
    Array.from({ length: DRONE_SLOTS }, () =>
      createHandDrone(app, droneSize, hoverOffset, bobAmplitude, bounds),
    ),
  )

  const parentContainer = new PIXI.Container()
  for (const [container] of drones) parentContainer.addChild(container)

  const update = (hands: HandData[]) => {
    const trackedPositions = drones.map(([, , getPos]) => getPos())
    const assigned = assignHandsToDrones(hands, trackedPositions, height, width)
    drones.forEach(([, updateSlot], i) => updateSlot(assigned[i]))
  }

  return [parentContainer, update] as const
}

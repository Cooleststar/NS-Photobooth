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
// How fast the rendered position catches up to the tracked hand, per second.
// Higher is more responsive but passes through more of the detector's jitter;
// lower is smoother but visibly trails a fast hand. Framerate-independent via
// the exponential below, so this is a real time constant rather than a
// per-frame fraction.
const FOLLOW_RATE = 14

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
// How far a drone may reach to claim a hand, as a fraction of screen width.
// Without a limit, a slot whose hand disappears for a frame will claim the
// nearest *available* hand no matter how far away it is — which is how a drone
// ends up flying across the room onto somebody else's palm. It is also what
// made things thrash with more hands than slots: the backend reports only its
// top few by confidence, that set churns frame to frame, and every churn let
// each slot re-pick from scratch.
//
// A hand genuinely moves a small fraction of the screen between updates, so
// anything beyond this is a different hand, not the same one having moved.
// Raise it if drones fail to follow fast hand movement; lower it if they still
// swap between people.
const MAX_CLAIM_DISTANCE_FACTOR = 0.25

function assignHandsToDrones(
  hands: HandData[],
  trackedPositions: Array<{ x: number; y: number; active: boolean }>,
  height: number,
  width: number,
): Array<{ x: number; y: number } | undefined> {
  const available = hands
    .filter(h => h.palmSky)
    .map(h => palmCenter(h, height, width))

  const result: Array<{ x: number; y: number } | undefined> = trackedPositions.map(() => undefined)
  const claimed = new Set<number>()
  const maxClaim = width * MAX_CLAIM_DISTANCE_FACTOR

  // Nearest pair first, rather than slot 0 first. Slot order is arbitrary, so
  // letting an early slot take a hand that is a much better match for a later
  // one is what produced drones trading places with each other.
  const pairs: Array<{ slot: number; hand: number; d: number }> = []
  for (let i = 0; i < trackedPositions.length; i++) {
    const pos = trackedPositions[i]
    for (let j = 0; j < available.length; j++) {
      const d = Math.hypot(available[j].x - pos.x, available[j].y - pos.y)
      if (d <= maxClaim) pairs.push({ slot: i, hand: j, d })
    }
  }
  pairs.sort((a, b) => a.d - b.d)

  const usedSlot = new Set<number>()
  for (const { slot, hand } of pairs) {
    if (usedSlot.has(slot) || claimed.has(hand)) continue
    result[slot] = available[hand]
    usedSlot.add(slot)
    claimed.add(hand)
  }

  // Leftover hands go to IDLE slots only, and those may reach any distance —
  // an idle drone is not on screen, so there is nothing to teleport: it simply
  // appears at the new hand. Without this, a hand raised far from every
  // existing drone would never get one.
  //
  // ACTIVE slots are deliberately excluded. A visible drone that found no hand
  // within maxClaim is left undefined, so the caller's hold timer keeps it in
  // place for a moment and then fades it out. Letting it take a distant hand
  // instead is exactly the "drone flies across the room onto someone else's
  // palm" behaviour this is meant to prevent — and since a hand dropping out
  // for a single frame turns an active slot into a free one, that path fired
  // constantly rather than rarely.
  const idleSlots = result
    .map((r, i) => (r === undefined && !trackedPositions[i].active ? i : -1))
    .filter(i => i >= 0)
  for (let j = 0; j < available.length && idleSlots.length; j++) {
    if (claimed.has(j)) continue
    const slot = idleSlots.shift()!
    result[slot] = available[j]
    claimed.add(j)
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

  // Two positions, deliberately. wristX/Y is the TARGET, updated only when a
  // backend sample arrives. drawnX/Y is what is actually rendered, eased
  // toward the target every frame.
  //
  // Without this the drone rendered at 60 fps from a target that only moved at
  // the hand-detection rate — around 11 fps with four hands in shot, since
  // WiLoR costs ~21 ms per hand and shares the GPU with YOLO-Pose and
  // ViTPose. The Kalman filter smooths across backend samples, not across
  // render frames, so the result was a drone that held still then jumped.
  let wristX = 0
  let wristY = 0
  let drawnX = 0
  let drawnY = 0
  let hasDrawn = false

  /** Drop the eased position so a drone that faded out and is later
   * re-acquired elsewhere appears there rather than flying across the screen.
   *
   * Deliberately NOT part of initialState(): that is called during setup,
   * before these `let` bindings exist, and touching them from there throws a
   * ReferenceError through the temporal dead zone — which silently prevented
   * the whole animation from being created. */
  const resetEasing = () => {
    hasDrawn = false
  }
  let bobTime = 0
  let palmHoldTimer = 0
  let palmConfirmTimer = 0
  const animManager = new AnimStateManager()

  // Expose tracked position so the parent can use it for proximity-based assignment
  // `active` distinguishes a slot that is currently showing a drone from an
  // idle one. The assigner needs that: an active drone must not be allowed to
  // jump to a distant hand, while an idle slot has to be able to acquire a
  // hand anywhere on screen or new hands would never get a drone at all.
  const getTrackedPos = () => ({ x: wristX, y: wristY, active: animManager.tracking })

  const update = (rawWrist: { x: number; y: number } | undefined) => {
    if (rawWrist) {
      palmHoldTimer = PALM_HOLD_TIME
      palmConfirmTimer = Math.min(PALM_CONFIRM_TIME, palmConfirmTimer + ticker.deltaMS / 1000)
      wristX = kf.x.filter(rawWrist.x)
      wristY = kf.y.filter(rawWrist.y)
      if (!hasDrawn) {
        // Snap on the FIRST REAL detection, not the first tick: ticks can
        // arrive before any hand does, and seeding from the still-zero target
        // would make the drone ease in from the top-left corner.
        drawnX = wristX
        drawnY = wristY
        hasDrawn = true
      }
    } else {
      palmHoldTimer = Math.max(0, palmHoldTimer - ticker.deltaMS / 1000)
      // Reset on any gap — confirmation must be one continuous detection,
      // not accumulated flickers, otherwise this stops filtering noise.
      palmConfirmTimer = 0
    }

    // Ease the rendered position toward the target once per render frame. The
    // rate is expressed per second and converted using deltaMS, so the motion
    // looks the same whether the display runs at 60 or 144 Hz.
    if (hasDrawn) {
      const k = 1 - Math.exp(-FOLLOW_RATE * (ticker.deltaMS / 1000))
      drawnX += (wristX - drawnX) * k
      drawnY += (wristY - drawnY) * k
    }

    // Already-tracking: tolerate brief gaps via the hold timer, no need to
    // re-confirm every tiny flicker. Not yet tracking: require the full
    // confirm duration first, so a single stray frame can't trigger it.
    const hasPerson = animManager.tracking
      ? rawWrist !== undefined || palmHoldTimer > 0
      : palmConfirmTimer >= PALM_CONFIRM_TIME

    animManager.tracking = hasPerson
    const { time, state } = animManager

    const targetY = drawnY - hoverOffset

    switch (state) {
      case 'exited':
        initialState()
        resetEasing()
        bobTime = 0
        break

      case 'entering': {
        container.alpha = 1
        if (!sprite.playing) sprite.play()
        sprite.alpha = lerpLinear(time, 0, ANIM.FADE)
        const progress = lerpEO(time, 0, ANIM.FADE)
        const startY = targetY - height * 0.2
        const ep = clampPos(drawnX, startY + (targetY - startY) * progress, droneSize, bounds)
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
        const tp = clampPos(drawnX, targetY + bob, droneSize, bounds)
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
          resetEasing()
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

  // DRONE_SLOTS must match WILOR_MAX_HANDS in backend/wilor_hands.py — that
  // is the actual ceiling on simultaneous drones, and the two have to move
  // together. Slots beyond the backend's cap are simply starved of data;
  // hands beyond the slot count get detected and then have nowhere to go.
  //
  // Both were 4, which is only two people showing both palms — an ordinary
  // group at a photo booth, so the ceiling sat in the middle of normal use.
  // Now 8. See WILOR_MAX_HANDS for the per-hand cost this buys.
  const DRONE_SLOTS = 8
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

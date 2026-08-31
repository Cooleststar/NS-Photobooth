import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear, lerpEO } from './utils'
import { AnimStateManager } from './AnimState'
import { HandData } from '../api/nicepipe'

import ocFusionImg from '../assets/OC_Fusion/OC_FUSION.png'

// Same shape as drone.ts throughout — same trigger signal (palm_up from the
// backend), same debounce/hover motion, same multi-hand slot assignment.
// The only real difference is the asset itself is a static PNG rather than
// an animated GIF, so there's no play()/stop()/currentFrame — which also
// makes this cheaper than the drone per-instance (no per-frame GIF decode).
const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
  RETRACK: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
}

const KF_PARAMS = { R: 0.02, Q: 1.5 }
const OC_FUSION_SIZE_FACTOR = 0.22
const BOB_SPEED = 2.5
const BOB_AMPLITUDE_FACTOR = 0.014
// Same values as drone.ts's PALM_HOLD_TIME/PALM_CONFIRM_TIME — tuned there
// against the same palm_up signal, so reuse rather than re-derive.
const PALM_HOLD_TIME = 0.4
const PALM_CONFIRM_TIME = 0.15

interface FeedBounds { left: number; right: number; top: number; bottom: number }

function clampPos(x: number, y: number, size: number, b: FeedBounds) {
  const half = size * 0.5
  return {
    x: Math.max(b.left + half, Math.min(b.right - half, x)),
    y: Math.max(b.top + half, Math.min(b.bottom - half, y)),
  }
}

// How far a slot may reach to claim a hand, as a fraction of screen width.
// Mirrors drone.ts's MAX_CLAIM_DISTANCE_FACTOR — see there for the reasoning.
const MAX_CLAIM_DISTANCE_FACTOR = 0.25

// Assign palm-up hand screen positions to slots by proximity — identical
// approach to drone.ts's assignHandsToDrones, so each instance sticks to
// the hand it's already near rather than swapping when sort order jitters.
function assignHandsToSlots(
  hands: HandData[],
  trackedPositions: Array<{ x: number; y: number; active: boolean }>,
  height: number,
  width: number,
): Array<{ x: number; y: number } | undefined> {
  const available = hands
    .filter(h => h.palmUp)
    .map(h => ({ x: (1 - h.x[0]) * width, y: h.y[0] * height }))

  const result: Array<{ x: number; y: number } | undefined> = trackedPositions.map(() => undefined)
  const claimed = new Set<number>()
  const maxClaim = width * MAX_CLAIM_DISTANCE_FACTOR

  // Nearest pair first, rather than slot 0 first: slot order is arbitrary, so
  // letting an early slot take a hand that is a much better match for a later
  // one is what made instances trade places with each other.
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

  // Leftover hands go to IDLE slots only, at any distance — an idle slot is
  // not on screen, so there is nothing to teleport. Active slots are excluded
  // so a visible sprite never jumps across to a stranger's hand.
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

async function createOCFusionSprite(
  app: PIXI.Application,
  texture: PIXI.Texture,
  size: number,
  hoverOffset: number,
  bobAmplitude: number,
  bounds: FeedBounds,
) {
  const { ticker } = app

  const container = new PIXI.Container()
  // Shares the one already-loaded texture across every slot — cheap, and
  // lets PixiJS batch these sprites together since they share a base texture.
  const sprite = PIXI.Sprite.from(texture)
  sprite.anchor.set(0.5, 0.5)
  sprite.width = size
  sprite.height = size
  container.addChild(sprite)

  const initialState = () => {
    container.alpha = 0
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

  // `active` lets the assigner tell a visible slot from an idle one: only an
  // idle slot may acquire a hand at any distance.
  const getTrackedPos = () => ({ x: wristX, y: wristY, active: animManager.tracking })

  const update = (rawWrist: { x: number; y: number } | undefined) => {
    if (rawWrist) {
      palmHoldTimer = PALM_HOLD_TIME
      palmConfirmTimer = Math.min(PALM_CONFIRM_TIME, palmConfirmTimer + ticker.deltaMS / 1000)
      wristX = kf.x.filter(rawWrist.x)
      wristY = kf.y.filter(rawWrist.y)
    } else {
      palmHoldTimer = Math.max(0, palmHoldTimer - ticker.deltaMS / 1000)
      palmConfirmTimer = 0
    }

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
        sprite.alpha = lerpLinear(time, 0, ANIM.FADE)
        const progress = lerpEO(time, 0, ANIM.FADE)
        const startY = targetY - app.renderer.height * 0.2
        const ep = clampPos(wristX, startY + (targetY - startY) * progress, size, bounds)
        container.position.set(ep.x, ep.y)
        if (time >= ANIM.FADE) animManager.transition()
        break
      }

      case 'entered': {
        sprite.alpha = 1
        container.alpha = 1
        bobTime += ticker.deltaMS / 1000
        const bob = Math.sin(bobTime * BOB_SPEED) * bobAmplitude
        const tp = clampPos(wristX, targetY + bob, size, bounds)
        container.position.set(tp.x, tp.y)
        break
      }

      case 'lost':
        // No re-track grace, same as drone — the hold timer above already
        // covers brief detection gaps.
        animManager.transition()
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

  return [container, update, getTrackedPos] as const
}

export async function createOCFusionAnim(
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

  const size = height * OC_FUSION_SIZE_FACTOR
  const hoverOffset = size
  const bobAmplitude = height * BOB_AMPLITUDE_FACTOR

  // Loaded once, shared texture across all slots (see createOCFusionSprite).
  const { texture } = await PIXI.ensureLoaded(app.loader, ocFusionImg)

  // Matches drone.ts's DRONE_SLOTS — same WILOR_MAX_HANDS ceiling, raised
  // from 4 to 8 so a group of four does not run out of slots.
  const OC_FUSION_SLOTS = 8
  const instances = await Promise.all(
    Array.from({ length: OC_FUSION_SLOTS }, () =>
      createOCFusionSprite(app, texture!, size, hoverOffset, bobAmplitude, bounds),
    ),
  )

  const parentContainer = new PIXI.Container()
  for (const [container] of instances) parentContainer.addChild(container)

  const update = (hands: HandData[]) => {
    const trackedPositions = instances.map(([, , getPos]) => getPos())
    const assigned = assignHandsToSlots(hands, trackedPositions, height, width)
    instances.forEach(([, updateSlot], i) => updateSlot(assigned[i]))
  }

  return [parentContainer, update] as const
}

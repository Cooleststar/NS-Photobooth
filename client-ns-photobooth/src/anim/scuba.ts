import { NormalizedLandmarkList } from '@mediapipe/drawing_utils'
import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear } from './utils'
import { convertPoint } from '../api/nicepipe/mpPose'
import { AnimStateManager } from './AnimState'
import { HandData } from '../api/nicepipe'

import scubaGif from '../assets/cat_anim/scuba.gif'

const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
}

const KF_PARAMS = { R: 0.03, Q: 2 }

// Person selection: gif follows whoever is closest to the camera (largest
// on-screen shoulder width). Hand detections from MediaPipe Hands aren't
// tied to a specific tracked person, so this "closest person" is only used
// to pick whose nose/torso the gesture is checked against — a new person
// must be meaningfully closer, and stay that way briefly, before the target
// switches, so two people standing at similar distance don't cause flicker.
const TARGET_SWITCH_MARGIN = 1.15
const TARGET_SWITCH_HOLD = 0.5

// Nose-pinch hand (static pose). Ratios of hand/shoulder scale rather than
// absolute pixels so this works regardless of distance from the camera.
// Like palm_up in the backend, these will likely need live tuning. Went
// 0.4/0.9 -> 0.55/1.3 -> 0.75/1.8 (too loose) -> back down to 0.6/1.4.
const PINCH_DIST_RATIO = 0.6    // thumb-tip <-> index-tip distance / hand scale
const NOSE_TOUCH_RATIO = 1.4    // pinch-point <-> nose distance / shoulder width

// Free-arm wave (dynamic/rhythmic). Only the wrist's own motion is used —
// per spec the wave is dominated by the wrist joint, not the whole arm —
// which is also all MediaPipe Hands can see without cross-referencing pose.
// NOTE: under RTSP mode 'both', hand + pose inference is throttled together
// to ~1/3 of camera framerate (backend/main.py _rtsp_reader), so effective
// sampling here is roughly 8fps, not the full camera rate — window/oscillation
// counts below are sized for that; tighten if a faster backend path is used.
const WAVE_WINDOW = 1.2                // seconds of wrist-y history analyzed
const WAVE_MIN_OSCILLATIONS = 1        // direction reversals required within the window
const WAVE_MIN_AMPLITUDE_RATIO = 0.015 // peak-to-peak wrist-y / shoulder width — floor, filters a still hand
const WAVE_MAX_AMPLITUDE_RATIO = 0.6   // ceiling — filters big overhead swings, not a wrist shimmer

// Combined-gesture debounce, same idea as drone.ts's PALM_CONFIRM/HOLD_TIME.
// GESTURE_CONFIRM_TIME is how long the gesture must hold before it first
// appears. GESTURE_HOLD_TIME is the grace period once already showing — how
// long a detection gap is tolerated before it disappears again; bumped to
// 5s on request so a brief break in the pose doesn't make it vanish.
const GESTURE_CONFIRM_TIME = 0.25
const GESTURE_HOLD_TIME = 5.0

interface FeedBounds { left: number; right: number; top: number; bottom: number }

function clampPos(x: number, y: number, size: number, b: FeedBounds) {
  const half = size * 0.5
  return {
    x: Math.max(b.left + half, Math.min(b.right - half, x)),
    y: Math.max(b.top + half, Math.min(b.bottom - half, y)),
  }
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

// ---------------------------------------------------------------------------
// Person selection — closest to camera, by on-screen shoulder width
// ---------------------------------------------------------------------------

function getTorso(pose: NormalizedLandmarkList, height: number, width: number) {
  const ls = pose[11]
  const rs = pose[12]
  const nose = pose[0]
  if (!ls || !rs || !nose) return undefined
  if ((ls.visibility ?? 1) < 0.5 || (rs.visibility ?? 1) < 0.5 || (nose.visibility ?? 1) < 0.5) return undefined
  const l = convertPoint(ls, height, width)
  const r = convertPoint(rs, height, width)
  const n = convertPoint(nose, height, width)
  const shoulderWidth = Math.hypot(l.x - r.x, l.y - r.y)
  if (shoulderWidth < 1) return undefined
  return {
    nose: { x: n.x, y: n.y },
    center: { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 },
    shoulderWidth,
  }
}

type Torso = NonNullable<ReturnType<typeof getTorso>>

function createPersonSelector() {
  let lockedId: number | undefined
  let candidateId: number | undefined
  let candidateTimer = 0

  return (
    allPoses: { [id: number]: NormalizedLandmarkList },
    height: number,
    width: number,
    deltaSec: number,
  ): { id: number; torso: Torso } | undefined => {
    const torsos = Object.entries(allPoses)
      .map(([id, pose]) => ({ id: Number(id), torso: getTorso(pose, height, width) }))
      .filter((e): e is { id: number; torso: Torso } => !!e.torso)

    if (torsos.length === 0) {
      lockedId = undefined
      candidateId = undefined
      candidateTimer = 0
      return undefined
    }

    torsos.sort((a, b) => b.torso.shoulderWidth - a.torso.shoulderWidth)
    const best = torsos[0]
    const locked = torsos.find((t) => t.id === lockedId)

    if (!locked) {
      lockedId = best.id
      candidateId = undefined
      candidateTimer = 0
    } else if (
      best.id !== lockedId &&
      best.torso.shoulderWidth > locked.torso.shoulderWidth * TARGET_SWITCH_MARGIN
    ) {
      if (candidateId !== best.id) {
        candidateId = best.id
        candidateTimer = 0
      }
      candidateTimer += deltaSec
      if (candidateTimer >= TARGET_SWITCH_HOLD) {
        lockedId = best.id
        candidateId = undefined
        candidateTimer = 0
      }
    } else {
      candidateId = undefined
      candidateTimer = 0
    }

    return torsos.find((t) => t.id === lockedId) ?? best
  }
}

// ---------------------------------------------------------------------------
// Hand classification
// ---------------------------------------------------------------------------

function handPoint(h: HandData, idx: number, height: number, width: number) {
  return { x: (1 - h.x[idx]) * width, y: h.y[idx] * height }
}

interface HandClassification {
  hand: HandData
  wrist: { x: number; y: number }
  noseTouch: boolean
}

function classifyHands(
  hands: HandData[],
  nose: { x: number; y: number },
  shoulderWidthPx: number,
  height: number,
  width: number,
): HandClassification[] {
  return hands.map((hand) => {
    const wrist = handPoint(hand, 0, height, width)
    const thumbTip = handPoint(hand, 4, height, width)
    const indexTip = handPoint(hand, 8, height, width)
    const midMcp = handPoint(hand, 9, height, width)

    const handScale = dist(wrist, midMcp)
    const isPinch = handScale > 1 && dist(thumbTip, indexTip) < PINCH_DIST_RATIO * handScale
    const pinchPoint = { x: (thumbTip.x + indexTip.x) / 2, y: (thumbTip.y + indexTip.y) / 2 }
    const isAtNose = dist(pinchPoint, nose) < NOSE_TOUCH_RATIO * shoulderWidthPx

    return { hand, wrist, noseTouch: isPinch && isAtNose }
  })
}

// ---------------------------------------------------------------------------
// Wave detection — rolling buffer of wrist-y, counting direction reversals
// ---------------------------------------------------------------------------

function createWaveDetector() {
  let buffer: { t: number; y: number }[] = []
  let lastLabel: string | undefined

  return (
    wristY: number | undefined,
    label: string | undefined,
    shoulderWidthPx: number,
    nowSec: number,
  ) => {
    if (wristY === undefined || label !== lastLabel) {
      buffer = []
      lastLabel = label
    }
    if (wristY === undefined) return { isWaving: false }

    buffer.push({ t: nowSec, y: wristY })
    const cutoff = nowSec - WAVE_WINDOW
    while (buffer.length > 0 && buffer[0].t < cutoff) buffer.shift()

    if (buffer.length < 4) return { isWaving: false }

    const ys = buffer.map((b) => b.y)
    const amplitude = Math.max(...ys) - Math.min(...ys)
    const deadzone = shoulderWidthPx * 0.01

    let oscillations = 0
    let dir = 0
    for (let i = 1; i < ys.length; i++) {
      const d = ys[i] - ys[i - 1]
      if (Math.abs(d) < deadzone) continue
      const newDir = d > 0 ? 1 : -1
      if (dir !== 0 && newDir !== dir) oscillations++
      dir = newDir
    }

    const amplitudeOk =
      amplitude > WAVE_MIN_AMPLITUDE_RATIO * shoulderWidthPx &&
      amplitude < WAVE_MAX_AMPLITUDE_RATIO * shoulderWidthPx

    return { isWaving: amplitudeOk && oscillations >= WAVE_MIN_OSCILLATIONS }
  }
}

// ---------------------------------------------------------------------------
// Scuba animation
// ---------------------------------------------------------------------------

export async function createScubaAnim(
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
  const sprite = await PIXI.ensureLoaded(loader, scubaGif).then((r) => r.animation!.clone())
  sprite.anchor.set(0.5, 0.5)
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
    size: new KalmanFilter(KF_PARAMS),
  }
  const pickPerson = createPersonSelector()
  const detectWave = createWaveDetector()
  const animManager = new AnimStateManager()

  let elapsedSec = 0
  let targetX = 0
  let targetY = 0
  let scubaSize = 150
  let gestureConfirmTimer = 0
  let gestureHoldTimer = 0

  const update = (allPoses: { [id: number]: NormalizedLandmarkList }, hands: HandData[]) => {
    const deltaSec = ticker.deltaMS / 1000
    elapsedSec += deltaSec
    const person = pickPerson(allPoses, height, width, deltaSec)

    let gestureNow = false
    let waveLabel: string | undefined
    let waveWristY: number | undefined

    if (person && hands.length >= 2) {
      const classified = classifyHands(hands, person.torso.nose, person.torso.shoulderWidth, height, width)
      const pinchHand = classified.find((c) => c.noseTouch)
      // free arm = the other hand, opposite label from the pinch hand
      const waveHand = pinchHand ? classified.find((c) => c.hand.label !== pinchHand.hand.label) : undefined

      waveLabel = waveHand?.hand.label
      waveWristY = waveHand?.wrist.y
      const { isWaving } = detectWave(waveWristY, waveLabel, person.torso.shoulderWidth, elapsedSec)
      gestureNow = !!pinchHand && !!waveHand && isWaving

      if (gestureNow) {
        const side = waveHand!.wrist.x > person.torso.center.x ? 1 : -1
        targetX = kf.x.filter(person.torso.center.x + side * person.torso.shoulderWidth * 1.3)
        targetY = kf.y.filter(person.torso.center.y + person.torso.shoulderWidth * 0.3)
        scubaSize = kf.size.filter(Math.max(80, person.torso.shoulderWidth * 1.8))
      }
    } else {
      detectWave(undefined, undefined, 0, elapsedSec)
    }

    if (gestureNow) {
      gestureConfirmTimer = Math.min(GESTURE_CONFIRM_TIME, gestureConfirmTimer + deltaSec)
      gestureHoldTimer = GESTURE_HOLD_TIME
    } else {
      gestureConfirmTimer = 0
      gestureHoldTimer = Math.max(0, gestureHoldTimer - deltaSec)
    }

    // Already tracking: tolerate brief gaps via the hold timer. Not yet
    // tracking: require the full confirm duration, so one stray frame can't
    // trigger it (same debounce shape as drone.ts).
    const hasGesture = animManager.tracking
      ? gestureNow || gestureHoldTimer > 0
      : gestureConfirmTimer >= GESTURE_CONFIRM_TIME

    animManager.tracking = hasGesture
    const { time, state } = animManager

    sprite.height = sprite.width = scubaSize

    switch (state) {
      case 'exited':
        initialState()
        break

      case 'entering': {
        container.alpha = 1
        if (!sprite.playing) sprite.play()
        sprite.alpha = lerpLinear(time, 0, ANIM.FADE)
        const ep = clampPos(targetX, targetY, scubaSize, bounds)
        container.position.set(ep.x, ep.y)
        if (time >= ANIM.FADE) animManager.transition()
        break
      }

      case 'entered': {
        if (!sprite.playing) sprite.play()
        sprite.alpha = 1
        container.alpha = 1
        const ep = clampPos(targetX, targetY, scubaSize, bounds)
        container.position.set(ep.x, ep.y)
        break
      }

      case 'lost':
        // No extra re-track grace here — GESTURE_HOLD_TIME above already
        // covers brief detection gaps, a second grace period would double up.
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

    animManager.update(deltaSec)
  }

  return [container, update] as const
}

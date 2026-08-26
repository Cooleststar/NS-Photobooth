import { NormalizedLandmarkList } from '@mediapipe/drawing_utils'
import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear } from './utils'
import { convertPoint } from '../api/nicepipe/mpPose'
import { AnimStateManager } from './AnimState'

import scubaGif from '../assets/cat_anim/scuba.gif'

const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
  RETRACK: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
}

const KF_PARAMS = { R: 0.03, Q: 2 }

const NOSE = 0

// Placement relative to the tracked person, in multiples of shoulder width.
const HEAD_CLEARANCE = 1.0 // how far above the nose the gif's center sits
const SIZE_FACTOR = 1.0
const MIN_SIZE = 50

interface FeedBounds { left: number; right: number; top: number; bottom: number }

function clampPos(x: number, y: number, size: number, b: FeedBounds) {
  const half = size * 0.5
  return {
    x: Math.max(b.left + half, Math.min(b.right - half, x)),
    y: Math.max(b.top + half, Math.min(b.bottom - half, y)),
  }
}

// ---------------------------------------------------------------------------
// Torso geometry — shoulder width scales the gesture thresholds below and
// the gif's own size/placement.
// ---------------------------------------------------------------------------

function getTorso(pose: NormalizedLandmarkList, height: number, width: number) {
  const ls = pose[11]
  const rs = pose[12]
  if (!ls || !rs) return undefined
  if ((ls.visibility ?? 1) < 0.5 || (rs.visibility ?? 1) < 0.5) return undefined
  const l = convertPoint(ls, height, width)
  const r = convertPoint(rs, height, width)
  const shoulderWidth = Math.hypot(l.x - r.x, l.y - r.y)
  if (shoulderWidth < 1) return undefined
  return {
    center: { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 },
    shoulderWidth,
  }
}

type Torso = NonNullable<ReturnType<typeof getTorso>>

/** Where the top of the head roughly is — the nose landmark if it's visible
 * (most accurate), else approximated as a fixed multiple of shoulder width
 * above the shoulder line (roughly a head-and-neck's worth) for when the
 * face is turned away from the camera but the torso's still tracked. */
function getHeadAnchor(
  pose: NormalizedLandmarkList,
  torso: Torso,
  height: number,
  width: number,
) {
  const nose = pose[NOSE]
  if (nose && (nose.visibility ?? 1) >= 0.5) return convertPoint(nose, height, width)
  return { x: torso.center.x, y: torso.center.y - torso.shoulderWidth * 0.9 }
}

// ---------------------------------------------------------------------------
// Scuba gesture — continuously swinging/waving a wrist (a small, repeated
// back-and-forth motion from the wrist, not a full arm swing), mirroring the
// scuba cat's own animation. Purely pose-based (both wrists), so it still
// only needs the 'pose' detection mode already wired up for this character.
//
// Measured as motion energy rather than counting clean direction reversals:
// reversal-counting turned out too fragile against real (noisy, irregularly
// sampled) landmark data — a single jittery frame breaks the alternating
// sequence and the gesture never registers. Instead this sums the wrist's
// total 2D path length over a rolling window (large for repeated back-and-
// forth motion, small for a hand held still or drifting slowly) and checks
// that path isn't just one straight sweep (net displacement much smaller
// than the path length actually walked) — the "continuously" part, so a
// single flick/reach doesn't count, only sustained repeated swinging.
//
// Thresholds below are a best-effort guess, not a tuned/verified fit (no
// live camera to test against here) — if the gesture still doesn't trigger,
// loosen MOTION_ENERGY_FACTOR/MIN_OSCILLATION_RATIO rather than assuming the
// landmark math itself is wrong.
// ---------------------------------------------------------------------------

const LEFT_WRIST = 15
const RIGHT_WRIST = 16
const VISIBILITY_MIN = 0.5
const SHAKE_WINDOW_SEC = 1.5       // how far back the motion buffer looks
// Total path length required within the window, in shoulder widths — a
// wrist-only wave, not a full arm swing, but well above what pose-landmark
// jitter alone produces (see MIN_STEP_FACTOR below for why jitter used to
// slip through this).
const MOTION_ENERGY_FACTOR = 0.6
// How much of that path must be "wasted" back-and-forth motion rather than
// net movement in one direction — kept fairly high so it takes sustained,
// continuous swinging rather than one big wave to trigger.
const MIN_OSCILLATION_RATIO = 0.4
// Per-step noise floor, in shoulder widths: a still hand's landmark position
// still wobbles a little frame to frame from pose-estimation jitter, and
// that wobble is almost pure back-and-forth (net displacement ~0), which
// used to satisfy MIN_OSCILLATION_RATIO on its own and let the gesture
// trigger "out of nowhere" while someone just stood still posing. Steps
// smaller than this are dropped before summing path length, so idle jitter
// no longer accumulates into anything.
const MIN_STEP_FACTOR = 0.02
const GESTURE_HOLD_SEC = 5         // how long the anim lingers after the gesture stops

type MotionPoint = { t: number; x: number; y: number }

function isShaking(buffer: MotionPoint[], shoulderWidth: number) {
  if (buffer.length < 4) return false
  const minStep = shoulderWidth * MIN_STEP_FACTOR
  let pathLength = 0
  for (let i = 1; i < buffer.length; i++) {
    const step = Math.hypot(buffer[i].x - buffer[i - 1].x, buffer[i].y - buffer[i - 1].y)
    if (step >= minStep) pathLength += step
  }
  const first = buffer[0]
  const last = buffer[buffer.length - 1]
  const netDisplacement = Math.hypot(last.x - first.x, last.y - first.y)
  if (pathLength < 1) return false
  const oscillationRatio = (pathLength - netDisplacement) / pathLength
  return (
    pathLength / shoulderWidth >= MOTION_ENERGY_FACTOR &&
    oscillationRatio >= MIN_OSCILLATION_RATIO
  )
}

// Gesture tracking state (buffers/hold timer) lives directly inside
// createScubaAnim below — one instance's closure per person, since
// createAnimForGif in Display.tsx spins up one createScubaAnim() per
// detected person (up to MAX_PEOPLE) when Multi-Person Tracking is on, each
// fed that one person's pose via the same stable per-person slot assignment
// every other multi-instance character (Clown, Pig Nose, ...) already uses. So
// this only ever needs to watch a single person, not pick amongst several.

// ---------------------------------------------------------------------------
// Scuba animation — hovers above the head of the person this instance is
// tracking, once they perform the scuba gesture above. Placed above the
// head rather than beside them so several instances (one per person, in
// Multi-Person Tracking mode) don't collide sideways.
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
  const buffers: Record<'left' | 'right', MotionPoint[]> = { left: [], right: [] }
  let elapsed = 0
  let triggeredUntil = -Infinity
  const animManager = new AnimStateManager()

  let targetX = 0
  let targetY = 0
  let scubaSize = 150

  const update = (pose: NormalizedLandmarkList) => {
    const deltaSec = ticker.deltaMS / 1000
    elapsed += deltaSec

    const torso = getTorso(pose, height, width)
    let gestureActive = false

    if (torso) {
      const leftLm = pose[LEFT_WRIST]
      const rightLm = pose[RIGHT_WRIST]
      const visible = (lm?: typeof leftLm) => !!lm && (lm.visibility ?? 1) >= VISIBILITY_MIN

      if (visible(leftLm)) {
        const p = convertPoint(leftLm, height, width)
        buffers.left.push({ t: elapsed, x: p.x, y: p.y })
      }
      if (visible(rightLm)) {
        const p = convertPoint(rightLm, height, width)
        buffers.right.push({ t: elapsed, x: p.x, y: p.y })
      }
      buffers.left = buffers.left.filter((s) => elapsed - s.t <= SHAKE_WINDOW_SEC)
      buffers.right = buffers.right.filter((s) => elapsed - s.t <= SHAKE_WINDOW_SEC)

      if (isShaking(buffers.left, torso.shoulderWidth) || isShaking(buffers.right, torso.shoulderWidth)) {
        triggeredUntil = elapsed + GESTURE_HOLD_SEC
      }
      gestureActive = elapsed < triggeredUntil

      const { shoulderWidth } = torso
      const head = getHeadAnchor(pose, torso, height, width)
      targetX = kf.x.filter(head.x)
      targetY = kf.y.filter(head.y - shoulderWidth * HEAD_CLEARANCE)
      scubaSize = kf.size.filter(Math.max(MIN_SIZE, shoulderWidth * SIZE_FACTOR))
    } else {
      // No torso this frame — buffers/hold state just stop accumulating
      // until tracking resumes; AnimStateManager's own RETRACK window
      // handles brief dropouts below.
      buffers.left = []
      buffers.right = []
    }

    animManager.tracking = gestureActive
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
        // Brief pose dropouts shouldn't make it vanish — hold position until
        // the retrack window expires, same as clown/owl/bat.
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

    animManager.update(deltaSec)
  }

  return [container, update] as const
}

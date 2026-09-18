import { NormalizedLandmarkList } from '../api/landmarks'
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
// Scuba gesture — continuously swinging/waving a wrist SIDE TO SIDE (a small,
// repeated left-right motion from the wrist, not a full arm swing), mirroring
// the scuba cat's own swimming animation. Vertical waving deliberately does
// not count; see MIN_HORIZONTAL_RATIO. Purely pose-based (both wrists), so it still
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
// Thresholds below started as a best-effort guess and have been retuned once
// already on real feedback: MOTION_ENERGY_FACTOR was initially too low (fired
// on almost no movement), then raised to 0.9, which fixed that but ended up
// requiring a full arm swing rather than a hand-only wave — the wrist
// landmark barely moves when only the hand rotates at the wrist, so a bigger
// energy requirement effectively demanded moving the whole forearm to rack up
// enough path length. Now lower again (see MOTION_ENERGY_FACTOR) to sit
// between those two — if the gesture still doesn't trigger, loosen
// MOTION_ENERGY_FACTOR/MIN_OSCILLATION_RATIO further rather than assuming the
// landmark math itself is wrong; if it fires too easily, raise them back up
// gradually rather than straight to 0.9.
// ---------------------------------------------------------------------------

const LEFT_WRIST = 15
const RIGHT_WRIST = 16
const VISIBILITY_MIN = 0.5
const SHAKE_WINDOW_SEC = 1.5       // how far back the motion buffer looks
// Total path length required within the window, in shoulder widths — meant
// to be reachable by flicking just the hand at the wrist, without swinging
// the whole forearm, since the wrist landmark itself barely translates when
// only the hand rotates. Well above what pose-landmark jitter alone produces
// (see MIN_STEP_FACTOR below for why jitter used to slip through this).
// Lowered from 0.9: at that level a wrist-only flick didn't move the wrist
// landmark far enough, and the gesture only triggered by swinging the
// whole arm from the shoulder/elbow, which read as "swing your arm" rather
// than "wave your hand". 0.9 itself was raised from an original 0.6 that
// fired on too little movement — if this turns out too sensitive again,
// come back up gradually rather than straight to 0.9.
const MOTION_ENERGY_FACTOR = 0.4
// How much of that path must be "wasted" back-and-forth motion rather than
// net movement in one direction — kept fairly high so it takes sustained,
// continuous swinging rather than one big wave to trigger. Lowered a bit
// alongside MOTION_ENERGY_FACTOR: a wrist-only flick has a smaller, less
// perfectly back-and-forth arc than a full arm swing, so demanding as much
// "wasted" motion as before would undo the point of lowering the energy
// requirement.
const MIN_OSCILLATION_RATIO = 0.3
// Per-step noise floor, in shoulder widths: a still hand's landmark position
// still wobbles a little frame to frame from pose-estimation jitter, and
// that wobble is almost pure back-and-forth (net displacement ~0), which
// used to satisfy MIN_OSCILLATION_RATIO on its own and let the gesture
// trigger "out of nowhere" while someone just stood still posing. Steps
// smaller than this are dropped before summing path length, so idle jitter
// no longer accumulates into anything. Lowered slightly alongside the two
// thresholds above so a smaller, wrist-only flick's individual steps don't
// themselves get filtered out as jitter.
const MIN_STEP_FACTOR = 0.015
// How much of the wrist's travel must be HORIZONTAL for the gesture to count,
// as a fraction of (horizontal + vertical) path. The scuba cat's own animation
// is a side-to-side swim, so an up-and-down wave should not summon it.
// A pure left-right wave scores 1.0, a 45-degree diagonal 0.5, pure up-down 0.
// 0.65 leaves room for the natural arc of a real wave while rejecting anything
// diagonal or vertical. Lower it if horizontal waves stop registering; raise it
// to insist on a flatter, more deliberate side-to-side motion.
const MIN_HORIZONTAL_RATIO = 0.65
// How long the swing must be sustained, continuously, before the cat first
// appears — on request, so a brief/accidental wave doesn't summon it.
// Separate from SHAKE_WINDOW_SEC/MOTION_ENERGY_FACTOR above: those decide
// whether THIS frame counts as "currently shaking" at all (energy within a
// rolling window), this decides how long that "currently shaking" verdict
// must hold true back-to-back before it's treated as deliberate rather than
// a quick flick.
//
// There used to also be a GESTURE_HOLD_SEC keeping the cat on screen for a
// bit after the gesture stopped, removed on request so it clears the instant
// you stop waving. Brief single-frame detection dropouts mid-gesture are
// still covered without it: AnimStateManager's own 'lost' state (see
// ANIM.RETRACK below) already holds the cat in place for VITE_ANIM_RETRACK
// seconds whenever animManager.tracking goes false for any reason, gesture
// dropouts included, so removing the separate hold here doesn't bring back
// the flicker that constant was guarding against.
const GESTURE_CONFIRM_SEC = 1

type MotionPoint = { t: number; x: number; y: number }

function isShaking(buffer: MotionPoint[], shoulderWidth: number) {
  if (buffer.length < 4) return false
  const minStep = shoulderWidth * MIN_STEP_FACTOR
  // Horizontal and vertical travel are accumulated separately, so the gesture
  // can require side-to-side motion specifically. Summing hypot(dx, dy) instead
  // — as this used to — makes an up-and-down wave score identically to a
  // left-right one, which is why waving vertically used to summon the cat.
  let pathX = 0
  let pathY = 0
  for (let i = 1; i < buffer.length; i++) {
    const dx = buffer[i].x - buffer[i - 1].x
    const dy = buffer[i].y - buffer[i - 1].y
    // Jitter rejection still tests the full 2D step: landmark wobble that
    // happens to land mostly on one axis should not count as real travel
    // along it.
    if (Math.hypot(dx, dy) < minStep) continue
    pathX += Math.abs(dx)
    pathY += Math.abs(dy)
  }
  if (pathX < 1) return false
  const first = buffer[0]
  const last = buffer[buffer.length - 1]
  // Oscillation is measured on the horizontal axis too, so one long sweep
  // across the body doesn't qualify — only repeated back-and-forth does.
  const netX = Math.abs(last.x - first.x)
  const oscillationRatio = (pathX - netX) / pathX
  const horizontalRatio = pathX / (pathX + pathY)
  return (
    pathX / shoulderWidth >= MOTION_ENERGY_FACTOR &&
    oscillationRatio >= MIN_OSCILLATION_RATIO &&
    horizontalRatio >= MIN_HORIZONTAL_RATIO
  )
}

// Gesture tracking state (buffers/hold timer) lives directly inside
// createScubaAnim below — one instance's closure per person, since
// createAnimForGif in Display.tsx spins up one createScubaAnim() per
// detected person (up to MAX_PEOPLE) when Multi-Person Tracking is on, each
// fed that one person's pose via the same stable per-person slot assignment
// every other multi-instance character (Clown Wig & Nose, Pig Nose, ...) already uses. So
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
  // Continuous-shaking duration this frame is part of — see GESTURE_CONFIRM_SEC.
  let confirmTimer = 0
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

      const shakingNow =
        isShaking(buffers.left, torso.shoulderWidth) || isShaking(buffers.right, torso.shoulderWidth)
      confirmTimer = shakingNow ? confirmTimer + deltaSec : 0

      // No hold-over: active only once the swing has been sustained
      // continuously for GESTURE_CONFIRM_SEC, and only for as long as
      // shakingNow keeps being true — stopping drops this immediately.
      gestureActive = confirmTimer >= GESTURE_CONFIRM_SEC

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
      confirmTimer = 0
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

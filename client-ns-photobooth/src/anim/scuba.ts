import { NormalizedLandmarkList } from '../api/landmarks'
import * as PIXI from '../pixi'
import { getAnimScale } from '../store'
import KalmanFilter from 'kalmanjs'

import { lerpLinear } from './utils'
import { convertPoint } from '../api/nicepipe/mpPose'
import { AnimStateManager } from './AnimState'
import { HandData } from '../api/nicepipe'

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
  // Was a hardcoded 0.5, inconsistent with the 0.3 this same file already
  // accepts for wrists. A torso that drops out takes the whole gesture with
  // it (the buffer and confirm timer both reset), so it is the worst place
  // in the chain to be the strictest.
  if ((ls.visibility ?? 1) < VISIBILITY_MIN || (rs.visibility ?? 1) < VISIBILITY_MIN) {
    return undefined
  }
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
// Scuba gesture — a hand held along the VERTICAL axis with the palm facing
// LEFT or RIGHT (the edge-on "knife hand", not a flat palm shown to the
// camera or turned to the sky), swept side to side, mirroring the scuba
// cat's own swimming animation.
//
// Every part of that test reads WiLoR's own estimate and nothing else. This
// is deliberate and is the whole point of the rebuild: HandData.angle and
// HandData.x/y silently switch to MediaPipe's landmarks on any frame where
// MediaPipe matched the hand (see wilor_hands.py's `match` branch), so a
// gesture built on them is measuring one thing on some frames and another
// thing on others. palmNormal/fingerAxis/wx/wy are always WiLoR's, so this
// gesture behaves identically whether or not MediaPipe saw the hand.
//
// Pose is still used, but only to place the cat above the right person's
// head and to decide which hand belongs to this instance's person — never
// to judge the gesture. That is why DETECTION_MODE_BY_GIF lists scuba as
// 'both'.
// ---------------------------------------------------------------------------

const LEFT_WRIST = 15
const RIGHT_WRIST = 16
// Pose confidence needed before a wrist landmark is used to claim a hand.
// Only gates the person-matching step, not the gesture itself.
const VISIBILITY_MIN = 0.3
// How far a hand may sit from this person's pose-tracked wrist and still
// count as theirs, in shoulder widths — so a neighbour's hand in frame is
// not picked up by mistake.
const MAX_HAND_MATCH_FACTOR = 1.0

// --- Orientation gates, both on WiLoR unit vectors in camera space ---------
//
// Camera space here has y growing DOWNWARD, matching the screen convention
// (see wilor_hands.py's _palm_normal_y: skyward reads negative).
//
// Both tests use absolute values, which makes the gesture independent of
// which way round the hand is AND independent of handedness: the left-hand
// chirality fix in _oriented negates only x, so |x| is identical either way.
// That matters because handedness itself comes from MediaPipe when it
// matched — taking the magnitude keeps even that out of the decision.

/** How much of the finger direction must lie on the vertical axis. A hand
 * pointing straight up or straight down scores 1.0, one pointing at the
 * camera or straight across scores 0. 0.6 is roughly within 37 degrees of
 * vertical — loose enough for a natural raised hand, tight enough that a
 * hand held out flat toward the camera cannot pass. */
const UPRIGHT_MIN = 0.6

/** How much of the palm normal must lie on the horizontal screen axis, i.e.
 * how squarely the palm faces left or right. A true knife-hand scores 1.0; a
 * palm shown to the camera, to the sky or to the floor scores near 0. This is
 * the test that rejects "up, down, forward or backwards". */
const PALM_SIDE_MIN = 0.6

/** Reject a hand the detector itself barely believes in, before its
 * orientation is trusted enough to gate a gesture on. */
const MIN_HAND_CONF = 0.5

// --- Motion, measured only while both gates above hold --------------------

const SHAKE_WINDOW_SEC = 1.5 // how far back the motion buffer looks
/** Total horizontal path required within the window, in shoulder widths. */
const MOTION_ENERGY_FACTOR = 0.25
/** How much of that path must be "wasted" back-and-forth travel rather than
 * net movement in one direction, so one long sweep across the body does not
 * qualify — only repeated swinging does. */
const MIN_OSCILLATION_RATIO = 0.2
/** Per-step noise floor, in shoulder widths. A still hand's detector box
 * still wobbles frame to frame, and that wobble is almost pure back-and-forth
 * (net displacement ~0), which would otherwise satisfy the oscillation test
 * on its own and fire while someone stands still. */
const MIN_STEP_FACTOR = 0.015
/** How much of the travel must be HORIZONTAL. The cat's own animation is a
 * side-to-side swim, so an up-and-down wave should not summon it. A pure
 * left-right wave scores 1.0, a 45-degree diagonal 0.5, pure up-down 0. */
const MIN_HORIZONTAL_RATIO = 0.5
/** How long the whole gesture must hold continuously before the cat appears,
 * so a single incidental swing does not trigger it. */
const GESTURE_CONFIRM_SEC = 0.3

/** How long a lost pose is tolerated before the gesture gives up on it.
 *
 * Pose does not arrive every frame. In 'both' mode the RTSP reader only runs
 * pose inference on every third frame (main.py's should_infer) and, unlike
 * the webcam path, broadcasts on the others regardless — and each message
 * replaces the client's pose wholesale, so scuba sees an empty pose far more
 * often than a populated one. Measured live: long runs of `pose=0` while
 * hands kept arriving normally.
 *
 * Treating each of those as "person gone" reset the motion buffer faster than
 * it could ever fill, which made the gesture impossible to complete rather
 * than merely hard. Hands are what the gesture actually reads, and they keep
 * coming, so the last known torso/wrists stand in across the gap — the same
 * tolerance AnimStateManager's 'lost' state already applies to placement.
 *
 * Three seconds, not the half second this started at: measured live, the gaps
 * run to a dozen seconds when the subject is close to the camera and their
 * shoulders sit near the frame edge, so a short window covered almost none of
 * them. The cost of being generous is only that the cat keeps following a
 * remembered position slightly too long after someone leaves. */
const POSE_GRACE_SEC = 3.0

type MotionPoint = { t: number; x: number; y: number }

/** Hand centre in screen pixels. wx/wy is WiLoR's own detector box centre,
 * already corrected for the video's inset rect (see Display.tsx). The feed is
 * mirrored for display, so x is flipped to match the pose landmarks it gets
 * compared against. */
function handPos(h: HandData, height: number, width: number) {
  return { x: (1 - h.wx) * width, y: h.wy * height }
}

/** Held along the vertical axis, palm square to the left or right.
 *
 * Returns false when the vectors are missing entirely, which is what an
 * older backend sends — the cat then simply never appears, rather than an
 * absent orientation reading as some particular direction. */
function isKnifeHand(h: HandData) {
  if (h.fingerAxis.length < 3 || h.palmNormal.length < 3) return false
  if (h.conf < MIN_HAND_CONF) return false
  return Math.abs(h.fingerAxis[1]) >= UPRIGHT_MIN && Math.abs(h.palmNormal[0]) >= PALM_SIDE_MIN
}

type SwingMetrics = { ok: boolean; energy: number; osc: number; horiz: number }

function isSwinging(buffer: MotionPoint[], shoulderWidth: number): SwingMetrics {
  const fail = { ok: false, energy: 0, osc: 0, horiz: 0 }
  if (buffer.length < 4) return fail
  const minStep = shoulderWidth * MIN_STEP_FACTOR
  // Horizontal and vertical travel are accumulated separately so the gesture
  // can require side-to-side motion specifically; summing hypot(dx, dy) would
  // score an up-and-down wave identically to a left-right one.
  let pathX = 0
  let pathY = 0
  for (let i = 1; i < buffer.length; i++) {
    const dx = buffer[i].x - buffer[i - 1].x
    const dy = buffer[i].y - buffer[i - 1].y
    // Jitter rejection tests the full 2D step: wobble that happens to land
    // mostly on one axis should not count as real travel along it.
    if (Math.hypot(dx, dy) < minStep) continue
    pathX += Math.abs(dx)
    pathY += Math.abs(dy)
  }
  if (pathX < 1) return fail
  const netX = Math.abs(buffer[buffer.length - 1].x - buffer[0].x)
  const energy = pathX / shoulderWidth
  const osc = (pathX - netX) / pathX
  const horiz = pathX / (pathX + pathY)
  return {
    ok:
      energy >= MOTION_ENERGY_FACTOR &&
      osc >= MIN_OSCILLATION_RATIO &&
      horiz >= MIN_HORIZONTAL_RATIO,
    energy,
    osc,
    horiz,
  }
}

type Wrists = { left?: { x: number; y: number }; right?: { x: number; y: number } }

/** Pairs this person's two wrists to the nearest hands, within maxDist — so a
 * hand belonging to a neighbouring person in frame is not claimed.
 *
 * Both wrists are resolved together, and a hand can only be claimed once.
 * Matching each side independently let a single hand win both wrists (seen
 * live: identical conf/vectors reported for left and right), which silently
 * halves the gesture's chances — one real hand occupying two slots while the
 * other hand is tracked by neither.
 */
function matchHands(
  wrists: Wrists,
  hands: HandData[],
  height: number,
  width: number,
  maxDist: number,
) {
  const pairs: { side: 'left' | 'right'; hand: HandData; d: number }[] = []
  for (const side of ['left', 'right'] as const) {
    const wrist = wrists[side]
    if (!wrist) continue
    for (const hand of hands) {
      const p = handPos(hand, height, width)
      const d = Math.hypot(p.x - wrist.x, p.y - wrist.y)
      if (d <= maxDist) pairs.push({ side, hand, d })
    }
  }
  // Closest pairing wins outright, then both that wrist and that hand are
  // out of the running — a greedy pass, which is exact enough for two.
  pairs.sort((a, b) => a.d - b.d)
  const out: { left?: HandData; right?: HandData } = {}
  const taken = new Set<HandData>()
  for (const { side, hand, d: _d } of pairs) {
    if (out[side] || taken.has(hand)) continue
    out[side] = hand
    taken.add(hand)
  }
  return out
}

// The x axis of the palm normal has never been checked against a known hold
// the way the y axis was (see _palm_normal_y's docstring — z was guessed
// wrong there and it went unnoticed for a while), so the thresholds above are
// reasoned, not measured. This reports every stage of the chain so a failure
// can be traced to the stage that actually broke rather than guessed at.
//
// Toggled from the browser console (`window.SCUBA_DEBUG = true`) rather than
// an env var, so it can be turned on against a running booth without
// restarting Vite and losing the camera session.
declare global {
  interface Window {
    SCUBA_DEBUG?: boolean
    /** Bypasses the gesture entirely and shows the cat whenever a torso is
     * tracked. Separates "the gesture never passes" from "the cat cannot
     * render", which look identical from the outside and would otherwise
     * both be chased as if they were the same bug. */
    SCUBA_FORCE?: boolean
    /** Rolling history of the diagnostic lines, so a pose can be held with
     * both hands in frame and read back afterwards — nobody can hold a hand
     * gesture and scroll the console at the same time. */
    SCUBA_LOG?: string[]
    /** The history as one string, ready for `copy(scubaDump())`. */
    scubaDump?: () => string
  }
}

/** Frames worth keeping. Only frames with something in them are recorded (see
 * debugLog), so this is ~48 seconds of ACTIVE tracking however long the walk
 * back to the keyboard takes. Recording idle frames instead made the history
 * useless in practice: holding a pose and then going to read it back flushed
 * the whole capture out with `hands=0` noise before it could be read. */
const LOG_HISTORY = 120

type SideDebug = {
  wrist: boolean
  matched: boolean
  conf?: number
  fingerAxis?: number[]
  palmNormal?: number[]
  upright?: boolean
  palmSide?: boolean
  buffered: number
  swing?: SwingMetrics
}

let lastLog = 0
function debugLog(
  handCount: number,
  torso: boolean,
  sides: Record<string, SideDebug>,
  pose?: NormalizedLandmarkList,
) {
  if (typeof window === 'undefined') return
  const now = performance.now()
  if (now - lastLog < 400) return
  lastLog = now
  const fmt = (v?: number[]) => (v ? v.map((n) => n.toFixed(2)).join(',') : '-')
  // Which way the vector mostly points, in words, so the axis labels can be
  // checked against what the hand is physically doing. If this disagrees with
  // the real hand, the local axis constants are wrong — not the thresholds.
  const dir = (v?: number[]) => {
    if (!v || v.length < 3) return '?'
    const [x, y, z] = v
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z)
    if (ax >= ay && ax >= az) return x > 0 ? 'SIDE(+x)' : 'SIDE(-x)'
    if (ay >= az) return y < 0 ? 'UP' : 'DOWN'
    return z > 0 ? 'CAMERA(+z)' : 'CAMERA(-z)'
  }
  const line = (name: string, d: SideDebug) =>
    `${name}: wrist=${d.wrist} matched=${d.matched}` +
    (d.matched
      ? ` conf=${d.conf?.toFixed(2)}` +
        ` fingersPoint=${dir(d.fingerAxis)} palmFaces=${dir(d.palmNormal)}` +
        ` finger=[${fmt(d.fingerAxis)}] palm=[${fmt(d.palmNormal)}]` +
        ` upright=${d.upright}(|fy|>=${UPRIGHT_MIN}) palmSide=${d.palmSide}(|nx|>=${PALM_SIDE_MIN})`
      : '') +
    ` buf=${d.buffered}` +
    (d.swing
      ? ` swing=${d.swing.ok} energy=${d.swing.energy.toFixed(2)}/${MOTION_ENERGY_FACTOR}` +
        ` osc=${d.swing.osc.toFixed(2)}/${MIN_OSCILLATION_RATIO}` +
        ` horiz=${d.swing.horiz.toFixed(2)}/${MIN_HORIZONTAL_RATIO}`
      : '')
  // Separates "no pose arrived at all" from "pose arrived but the shoulders
  // scored under VISIBILITY_MIN" — the two need completely different fixes.
  const vis = (i: number) => {
    const lm = pose?.[i]
    return lm ? (lm.visibility ?? 1).toFixed(2) : 'none'
  }
  const poseInfo = `pose=${pose?.length ?? 0} shoulderVis=[${vis(11)},${vis(12)}]/${VISIBILITY_MIN}`
  const text =
    `[scuba] hands=${handCount} torso=${torso} ${poseInfo}` +
    (Object.keys(sides).length
      ? '\n  ' + Object.entries(sides).map(([n, d]) => line(n, d)).join('\n  ')
      : '')

  // Recorded without needing the flag, printed only on request — recording
  // is what makes a hands-busy pose capturable at all. Empty frames are
  // dropped rather than stored so that walking back to the keyboard cannot
  // evict the capture; an all-idle history would say nothing anyway.
  window.scubaDump ??= () => (window.SCUBA_LOG ?? []).join('\n')
  if (handCount > 0 || torso) {
    const history = (window.SCUBA_LOG ??= [])
    history.push(text)
    if (history.length > LOG_HISTORY) history.shift()
  }

  // console.log, not console.debug: DevTools hides debug-level output unless
  // "Verbose" is ticked, which looks identical to the code never running.
  if (window.SCUBA_DEBUG === true) console.log(text)
}

// ---------------------------------------------------------------------------
// Scuba animation — hovers above the head of the person this instance is
// tracking, once they perform the gesture above. Placed above the head rather
// than beside them so several instances (one per person, in Multi-Person
// Tracking mode) don't collide sideways.
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
  let confirmTimer = 0
  const animManager = new AnimStateManager()

  let targetX = 0
  let targetY = 0
  let scubaSize = 150
  let lastPose: { torso: Torso; wrists: Wrists; at: number } | undefined

  const update = (pose: NormalizedLandmarkList, hands: HandData[]) => {
    const deltaSec = ticker.deltaMS / 1000
    elapsed += deltaSec

    const freshTorso = getTorso(pose, height, width)
    if (freshTorso) {
      const visible = (lm?: NormalizedLandmarkList[number]) =>
        !!lm && (lm.visibility ?? 1) >= VISIBILITY_MIN
      const leftLm = pose[LEFT_WRIST]
      const rightLm = pose[RIGHT_WRIST]
      lastPose = {
        torso: freshTorso,
        wrists: {
          left: visible(leftLm) ? convertPoint(leftLm, height, width) : undefined,
          right: visible(rightLm) ? convertPoint(rightLm, height, width) : undefined,
        },
        at: elapsed,
      }
    }
    // Falls back to the most recent pose while it is still fresh enough to
    // describe where this person is — see POSE_GRACE_SEC.
    const recent =
      lastPose && elapsed - lastPose.at <= POSE_GRACE_SEC ? lastPose : undefined

    let gestureActive = false

    if (recent) {
      const torso = recent.torso
      const wrists = recent.wrists
      const maxMatch = torso.shoulderWidth * MAX_HAND_MATCH_FACTOR

      const matched = matchHands(wrists, hands, height, width, maxMatch)
      const dbg: Record<string, SideDebug> = {}
      for (const side of ['left', 'right'] as const) {
        const hand = matched[side]
        const d: SideDebug = { wrist: !!wrists[side], matched: !!hand, buffered: 0 }
        if (hand) {
          d.conf = hand.conf
          d.fingerAxis = hand.fingerAxis
          d.palmNormal = hand.palmNormal
          d.upright = Math.abs(hand.fingerAxis[1] ?? 0) >= UPRIGHT_MIN
          d.palmSide = Math.abs(hand.palmNormal[0] ?? 0) >= PALM_SIDE_MIN
        }
        // Losing the orientation for even one frame clears the buffer, so the
        // palm has to STAY facing left/right across the whole swing rather
        // than passing through that pose on the way to something else. This
        // is what enforces the "while palm still faces left or right" half of
        // the gesture; without it a hand rolling over mid-wave would still
        // accumulate path length and trigger.
        if (!hand || !isKnifeHand(hand)) {
          buffers[side] = []
        } else {
          const p = handPos(hand, height, width)
          buffers[side].push({ t: elapsed, x: p.x, y: p.y })
          buffers[side] = buffers[side].filter((s) => elapsed - s.t <= SHAKE_WINDOW_SEC)
        }
        d.buffered = buffers[side].length
        dbg[side] = d
      }

      const swingLeft = isSwinging(buffers.left, torso.shoulderWidth)
      const swingRight = isSwinging(buffers.right, torso.shoulderWidth)
      dbg['left'].swing = swingLeft
      dbg['right'].swing = swingRight
      debugLog(hands.length, true, dbg, pose)

      confirmTimer = swingLeft.ok || swingRight.ok ? confirmTimer + deltaSec : 0
      gestureActive = confirmTimer >= GESTURE_CONFIRM_SEC

      // Only on a genuinely fresh pose: re-filtering a stale head position
      // every frame would feed the Kalman filters the same sample repeatedly
      // and let them converge onto a position the person has since left.
      if (freshTorso) {
        const { shoulderWidth } = freshTorso
        const head = getHeadAnchor(pose, freshTorso, height, width)
        targetX = kf.x.filter(head.x)
        targetY = kf.y.filter(head.y - shoulderWidth * HEAD_CLEARANCE)
        scubaSize =
          kf.size.filter(Math.max(MIN_SIZE, shoulderWidth * SIZE_FACTOR)) *
          getAnimScale('scuba')
      }
    } else {
      // No torso this frame — stop accumulating until tracking resumes.
      // AnimStateManager's own RETRACK window covers brief dropouts below.
      buffers.left = []
      buffers.right = []
      confirmTimer = 0
      debugLog(hands.length, false, {}, pose)
    }

    // Outside the torso branch on purpose: the point of the override is to
    // prove the cat can render at all, and the case worth proving is exactly
    // the one where pose is missing. It falls back to the last known
    // placement, which is enough to see the sprite.
    animManager.tracking =
      gestureActive || (typeof window !== 'undefined' && window.SCUBA_FORCE === true)
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

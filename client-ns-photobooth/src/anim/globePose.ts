// The globe's pose gates, split out of globe.ts so they can be tested without
// PIXI or the gif asset that file imports. Pure: landmarks in, verdicts out.
// Same pattern as batArm.ts.

import { NormalizedLandmarkList } from '../api/landmarks'
import { convertPoint } from '../api/nicepipe/mpPose'

/** Gate thresholds, in two sets for hysteresis - ACQUIRE for a globe that is
 * not yet on the torso / not yet held, KEEP for one that already is.
 *
 * The hands gate is what the globe used to get wrong. It accepted wrists
 * anywhere from the shoulder line down to 1.5 shoulder-widths below it, and
 * only checked their AVERAGE height. 1.5 shoulder-widths is roughly hip and
 * groin height, which is exactly where relaxed arms hang, and relaxed wrists
 * beside the hips are routinely more than 1.2 shoulder-widths apart. So a
 * guest just standing there kept flipping the globe out of its orbit onto the
 * midpoint of their wrists - their groin - and back, frame to frame.
 *
 * Every limit below is now measured on the axis it constrains: heights in
 * torso lengths (shoulder line to hip line), widths in shoulder widths. The
 * old band compared a height against a width, so turning sideways, or the
 * webcam path stretching a camera whose aspect ratio differs from Detection
 * Resolution, moved it.
 *
 * - shoulderMinVis / armMinVis: landmark confidence.
 * - bandTop / bandBottom: where EACH wrist may sit, in torso lengths below
 *   the shoulder line (negative = above it). The hips are at 1.0, so even
 *   KEEP's bottom stays well clear of them.
 * - maxBelowElbow: how far a wrist may hang below its own elbow, in torso
 *   lengths. Holding something up keeps the wrists near elbow height; arms at
 *   rest hang them a whole forearm below, which this alone rules out.
 * - minSep / maxSep: wrist separation, in shoulder widths. The upper bound
 *   keeps a T-pose (the bat's trigger) from also counting as a hold. */
export const GLOBE_GATES = {
  ACQUIRE: {
    shoulderMinVis: 0.5,
    armMinVis: 0.5,
    bandTop: -0.15,
    bandBottom: 0.55,
    maxBelowElbow: 0.15,
    minSep: 1.2,
    maxSep: 3.0,
  },
  KEEP: {
    shoulderMinVis: 0.3,
    armMinVis: 0.35,
    bandTop: -0.25,
    bandBottom: 0.65,
    maxBelowElbow: 0.25,
    minSep: 1.0,
    maxSep: 3.4,
  },
} as const

/** Hips need this much confidence before the torso length is taken from them. */
export const HIP_MIN_VIS = 0.5
/** Hips at or below this normalised y are treated as clipped to the frame
 * edge (convert8bitKeypoint clamps to [0,1]) - a waist-up shot piles
 * extrapolated hips at the bottom, which says nothing about where they are. */
export const HIP_MAX_Y = 0.98
/** Torso length assumed when the hips can't be trusted, in shoulder widths. */
export const FALLBACK_TORSO_RATIO = 1.4
/** A hip-derived torso shorter than this many shoulder widths is implausible
 * (bad hips, or someone leaning right into the lens) - fall back instead. */
export const MIN_TORSO_RATIO = 0.5
/** Shoulders closer together than this, in pixels, are a degenerate pose. */
export const MIN_SHOULDER_PX = 10

export interface TorsoAnchor {
  /** shoulder midpoint, screen pixels */
  x: number
  y: number
  shoulderWidth: number
  /** shoulder line to hip line, screen pixels (estimated if hips untrusted) */
  torsoLen: number
  hipsTrusted: boolean
}

export type TorsoCheck =
  | { ok: true; torso: TorsoAnchor }
  | { ok: false; reason: string }

export type HandsCheck =
  | { ok: true; x: number; y: number; distance: number }
  | { ok: false; reason: string }

/** Where the globe orbits: the shoulder midpoint, plus the shoulder width and
 * torso length every other globe measurement is scaled by.
 *
 * Visibility defaults to 0 when missing. The old check was
 * `visibility! < 0.5`, which an undefined visibility passes (NaN < 0.5 is
 * false). A shoulder at exactly (0,0) is rejected too - that is how the
 * backend's _to_mp33 fills a landmark it has no data for. */
export function getTorsoAnchor(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
  keep = false,
): TorsoCheck {
  if (pose.length === 0) return { ok: false, reason: 'noPose' }
  const gate = keep ? GLOBE_GATES.KEEP : GLOBE_GATES.ACQUIRE
  const ls = pose[11]
  const rs = pose[12]
  if (!ls || !rs) return { ok: false, reason: 'missing' }
  const vis = Math.min(ls.visibility ?? 0, rs.visibility ?? 0)
  if (vis < gate.shoulderMinVis) return { ok: false, reason: `shVis=${vis.toFixed(2)}` }
  if ((ls.x === 0 && ls.y === 0) || (rs.x === 0 && rs.y === 0)) {
    return { ok: false, reason: 'shUnfilled' }
  }

  const l = convertPoint(ls, height, width)
  const r = convertPoint(rs, height, width)
  const shoulderWidth = Math.abs(l.x - r.x)
  if (shoulderWidth < MIN_SHOULDER_PX) return { ok: false, reason: 'shDegenerate' }
  const x = (l.x + r.x) / 2
  const y = (l.y + r.y) / 2

  let torsoLen = shoulderWidth * FALLBACK_TORSO_RATIO
  let hipsTrusted = false
  const lh = pose[23]
  const rh = pose[24]
  if (
    lh && rh &&
    Math.min(lh.visibility ?? 0, rh.visibility ?? 0) >= HIP_MIN_VIS &&
    lh.y < HIP_MAX_Y && rh.y < HIP_MAX_Y
  ) {
    const hipY = (convertPoint(lh, height, width).y + convertPoint(rh, height, width).y) / 2
    // Confident hips above the shoulders are garbage keypoints, not a pose
    // anyone at a booth is in - better to skip the frame than orbit it.
    if (hipY <= y) return { ok: false, reason: 'hipsAboveShoulders' }
    if (hipY - y >= shoulderWidth * MIN_TORSO_RATIO) {
      torsoLen = hipY - y
      hipsTrusted = true
    }
  }

  return { ok: true, torso: { x, y, shoulderWidth, torsoLen, hipsTrusted } }
}

/** Whether the person is holding their hands apart at chest height - the
 * pose that pulls the globe out of its orbit and in between their hands.
 *
 * Each wrist is judged on its own: one hand raised and the other hanging
 * used to average out to "chest level". The wrists only have to straddle the
 * torso midline, not be on any particular side of it, because which landmark
 * ends up on screen-left depends on the mirror in convertPoint and on the
 * webcam's Flip H setting. */
export function checkHandsHold(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
  torso: TorsoAnchor,
  keep = false,
): HandsCheck {
  const gate = keep ? GLOBE_GATES.KEEP : GLOBE_GATES.ACQUIRE
  const le = pose[13]
  const re = pose[14]
  const lw = pose[15]
  const rw = pose[16]
  if (!le || !re || !lw || !rw) return { ok: false, reason: 'missing' }
  const vis = Math.min(
    le.visibility ?? 0, re.visibility ?? 0, lw.visibility ?? 0, rw.visibility ?? 0,
  )
  if (vis < gate.armMinVis) return { ok: false, reason: `armVis=${vis.toFixed(2)}` }

  const arms = [
    { tag: 'L', e: convertPoint(le, height, width), w: convertPoint(lw, height, width) },
    { tag: 'R', e: convertPoint(re, height, width), w: convertPoint(rw, height, width) },
  ]
  for (const { tag, e, w } of arms) {
    const band = (w.y - torso.y) / torso.torsoLen
    if (band < gate.bandTop || band > gate.bandBottom) {
      return { ok: false, reason: `band${tag}=${band.toFixed(2)}` }
    }
    const drop = (w.y - e.y) / torso.torsoLen
    if (drop > gate.maxBelowElbow) {
      return { ok: false, reason: `drop${tag}=${drop.toFixed(2)}` }
    }
  }

  const [a, b] = [arms[0].w, arms[1].w]
  if (!(Math.min(a.x, b.x) < torso.x && torso.x < Math.max(a.x, b.x))) {
    return { ok: false, reason: 'noStraddle' }
  }
  const distance = Math.abs(a.x - b.x)
  const sep = distance / torso.shoulderWidth
  if (sep < gate.minSep || sep > gate.maxSep) {
    return { ok: false, reason: `sep=${sep.toFixed(2)}` }
  }

  return { ok: true, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance }
}

export interface LatchState {
  on: boolean
  /** seconds of unbroken qualification so far, capped at confirmS */
  confirm: number
  /** seconds left before an 'on' latch lets go without qualification */
  hold: number
}

export const createLatch = (): LatchState => ({ on: false, confirm: 0, hold: 0 })

/** Debounce for a per-frame yes/no - the same confirm/hold semantics as
 * bat.ts's ARM_CONFIRM_TIME/ARM_HOLD_TIME, pulled out so it can be tested.
 * Turning on needs `confirmS` of UNBROKEN qualification; turning off needs
 * `holdS` with none at all.
 *
 * In seconds, never frames: the webcam path detects at ~10Hz (a DSLR through
 * a capture card can drop to ~5) while the ticker runs at 60, so the same
 * pose is replayed for several ticks, and a frame count would mean something
 * different on every source. Mutates `s`, returns the new `on`. */
export function stepLatch(
  s: LatchState,
  qualified: boolean,
  dt: number,
  { confirmS, holdS }: { confirmS: number; holdS: number },
): boolean {
  if (qualified) {
    s.confirm = Math.min(confirmS, s.confirm + dt)
    s.hold = holdS
    if (!s.on && s.confirm >= confirmS) s.on = true
  } else {
    s.confirm = 0
    s.hold = Math.max(0, s.hold - dt)
    if (s.on && s.hold <= 0) s.on = false
  }
  return s.on
}

/** Reset a latch in place. */
export function resetLatch(s: LatchState) {
  s.on = false
  s.confirm = 0
  s.hold = 0
}

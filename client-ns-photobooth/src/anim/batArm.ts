// The bat's arm gate, split out of bat.ts so it can be tested without PIXI
// or the gif assets that file imports. Pure: landmarks in, target out.

import { NormalizedLandmarkList } from '../api/landmarks'
import { convertPoint } from '../api/nicepipe/mpPose'

// Where along the forearm (elbow->wrist) the bat lands, as a fraction of
// that segment — 0 would be the elbow, 1 the wrist itself. Kept short of 1 so
// the bat perches on the forearm rather than on the hand.
export const FOREARM_LAND_RATIO = 0.75

/** Gate thresholds, in two sets for hysteresis — ACQUIRE for an arm the bat
 * is not on yet, KEEP for the arm it is already locked onto.
 *
 * ACQUIRE is the original single set, unchanged, so summoning the bat is no
 * easier than before:
 *
 * - minVis: shoulder, elbow, wrist and hip visibility. 0.5 -> 0.35 on
 *   request, so a slightly-occluded or edge-of-frame arm still qualifies.
 * - maxStraightDeg: max angle between the upper arm (shoulder->elbow) and
 *   forearm (elbow->wrist) before the arm no longer counts as "straight".
 *   Widened 25 -> 40 on request.
 * - awayMinDeg/awayMaxDeg: allowed range for the angle between the upper arm
 *   and the torso (shoulder->hip, same side) — "how far the arm is held away
 *   from the body". 90 is a horizontal, T-pose-style arm; an arm hanging at
 *   the side (~0) or raised overhead (~180) does not qualify.
 *
 * KEEP exists because an arm held still sat right on those boundaries: the
 * hip especially is tracked noisily at photobooth range, and with a 4-landmark,
 * 3-threshold condition that all had to hold on the same frame, runs of misses
 * outlasted ARM_HOLD_TIME and the bat flew off an arm that never moved. KEEP
 * relaxes every limit, and drops the hip's visibility requirement: once the
 * hip is too uncertain to trust, the torso is taken as straight down the
 * image instead (people at a booth stand upright), so the away-from-body test
 * still runs — an arm lowered to the side still sends the bat away. That
 * fallback is KEEP-only; a fresh arm still needs a tracked hip. */
export const BAT_ARM_GATES = {
  ACQUIRE: { minVis: 0.35, hipMinVis: 0.35, maxStraightDeg: 40, awayMinDeg: 70, awayMaxDeg: 120 },
  KEEP: { minVis: 0.25, hipMinVis: 0.25, maxStraightDeg: 50, awayMinDeg: 60, awayMaxDeg: 130 },
} as const

export type BatArmSide = 'left' | 'right'
export type BatArmTarget = { x: number; y: number; side: BatArmSide; vis: number }
export type BatArmCheck =
  | { ok: true; target: BatArmTarget }
  | { ok: false; reason: string }

/** Evaluates ONE specific arm (not "whichever is more confident") against
 * every qualification check — visibility, elbow straightness, and away-from-
 * body angle — reporting which check failed, for armDebug. */
export function checkBatArm(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
  side: BatArmSide,
  keep = false,
): BatArmCheck {
  const gate = keep ? BAT_ARM_GATES.KEEP : BAT_ARM_GATES.ACQUIRE
  const useLeft = side === 'left'
  const s = pose[useLeft ? 11 : 12]
  const e = pose[useLeft ? 13 : 14]
  const w = pose[useLeft ? 15 : 16]
  const h = pose[useLeft ? 23 : 24]
  if (!s || !e || !w) return { ok: false, reason: 'missing' }
  const vis = Math.min(s.visibility ?? 0, e.visibility ?? 0, w.visibility ?? 0)
  if (vis < gate.minVis) return { ok: false, reason: `vis=${vis.toFixed(2)}` }
  const hipVis = h?.visibility ?? 0
  const hipOk = !!h && hipVis >= gate.hipMinVis
  if (!hipOk && !keep) return { ok: false, reason: `hipVis=${hipVis.toFixed(2)}` }

  const shoulder = convertPoint(s, height, width)
  const elbow = convertPoint(e, height, width)
  const wrist = convertPoint(w, height, width)

  const upperArm = { x: elbow.x - shoulder.x, y: elbow.y - shoulder.y }
  const forearm = { x: wrist.x - elbow.x, y: wrist.y - elbow.y }
  const upperArmLen = Math.hypot(upperArm.x, upperArm.y)
  const forearmLen = Math.hypot(forearm.x, forearm.y)
  if (upperArmLen < 1 || forearmLen < 1) return { ok: false, reason: 'degenerate' }

  const cosDeviation =
    (upperArm.x * forearm.x + upperArm.y * forearm.y) / (upperArmLen * forearmLen)
  const maxCos = Math.cos((gate.maxStraightDeg * Math.PI) / 180)
  if (cosDeviation < maxCos) {
    const bend = (Math.acos(Math.min(1, Math.max(-1, cosDeviation))) * 180) / Math.PI
    return { ok: false, reason: `bend=${bend.toFixed(0)}` }
  }

  // "Away from the body" — angle between the upper arm and the torso
  // (shoulder->hip, same side), not the elbow-straightness check above.
  // KEEP falls back to straight down the image when the hip is uncertain.
  let torso = { x: 0, y: 1 }
  if (hipOk) {
    const hip = convertPoint(h!, height, width)
    torso = { x: hip.x - shoulder.x, y: hip.y - shoulder.y }
  }
  const torsoLen = Math.hypot(torso.x, torso.y)
  if (torsoLen < 1) return { ok: false, reason: 'degenerate' }
  const cosArmTorso =
    (upperArm.x * torso.x + upperArm.y * torso.y) / (upperArmLen * torsoLen)
  const armTorsoDeg = (Math.acos(Math.min(1, Math.max(-1, cosArmTorso))) * 180) / Math.PI
  if (armTorsoDeg < gate.awayMinDeg || armTorsoDeg > gate.awayMaxDeg) {
    return { ok: false, reason: `away=${armTorsoDeg.toFixed(0)}${hipOk ? '' : '(noHip)'}` }
  }

  return {
    ok: true,
    target: {
      x: elbow.x + (wrist.x - elbow.x) * FOREARM_LAND_RATIO,
      y: elbow.y + (wrist.y - elbow.y) * FOREARM_LAND_RATIO,
      side,
      vis,
    },
  }
}

/** target coords for the bat to land on, assuming a bottom-middle anchor —
 * a point along the forearm (elbow->wrist, MP-33 indices 13/14 and 15/16),
 * short of the wrist so the bat perches on the forearm rather than the hand
 * (see FOREARM_LAND_RATIO), on whichever arm is straight and held away from
 * the body at roughly a right angle (see BAT_ARM_GATES). Deliberately not
 * using calculateArmFromPose's elbow+angle+length reconstruction: that angle
 * is computed with Math.atan (not atan2), which can't recover which side of
 * the elbow the wrist is actually on, so it only ever looked right for the
 * owl's halfway-point perch — reaching further toward the wrist regularly
 * landed on the wrong side entirely. This uses plain vector subtraction
 * instead, which has no such sign ambiguity.
 *
 * `lockedSide`, if given, is tried FIRST, against the looser KEEP gates, and
 * used as long as it still qualifies — even if the other arm is now more
 * confidently tracked. Without this, raising both arms (both qualifying) left
 * the choice up to whichever side edged out the other on visibility that
 * particular frame, which flips back and forth from ordinary tracking noise —
 * the bat visibly hopping between arms rather than settling on the one it
 * first landed on. Only falls back to confidence-based picking (against
 * ACQUIRE) once the locked side actually stops qualifying.
 *
 * `diag`, if given, is filled with each side's gate outcome for armDebug. */
export function getForearmTarget(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
  lockedSide?: BatArmSide,
  diag?: Partial<Record<BatArmSide, string>>,
): BatArmTarget | undefined {
  if (pose.length === 0) {
    if (diag) diag.left = diag.right = 'noPose'
    return undefined
  }
  const evaluate = (side: BatArmSide, keep: boolean) => {
    const r = checkBatArm(pose, height, width, side, keep)
    if (diag) diag[side] = r.ok ? 'ok' : r.reason
    return r.ok ? r.target : undefined
  }

  if (lockedSide) {
    const locked = evaluate(lockedSide, true)
    if (locked) return locked
  }

  // No locked side, or it stopped qualifying — fall back to picking by
  // confidence between whichever arm(s) currently qualify. A locked side that
  // just failed KEEP cannot pass the stricter ACQUIRE, so it is skipped.
  const left = lockedSide === 'left' ? undefined : evaluate('left', false)
  const right = lockedSide === 'right' ? undefined : evaluate('right', false)
  if (!left && !right) return undefined
  if (!left) return right
  if (!right) return left
  return left.vis >= right.vis ? left : right
}

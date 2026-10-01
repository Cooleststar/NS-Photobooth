import {
  NormalizedLandmark,
  NormalizedLandmarkList,
} from '../landmarks'

/** converts normalizedLandmark to unnormalized coordinates */
export function convertPoint(
  point: NormalizedLandmark,
  height: number,
  width: number,
): NormalizedLandmark {
  return {
    x: (1 - point.x) * width,
    y: point.y * height,
    z: point.z,
    visibility: point.visibility,
  }
}

export type ArmSide = 'left' | 'right'
export type ArmPose = { x: number; y: number; angle: number; length: number }

/** Gate thresholds for the owl's arm. Two sets, for hysteresis.
 *
 * ACQUIRE is what a fresh arm must meet, and is unchanged from the original
 * single set - so summoning the owl is no easier than it was. KEEP is what
 * the arm the owl is already perched on must keep meeting, and is looser.
 *
 * With one set, an arm held still sat right on the boundary: ordinary
 * frame-to-frame noise in keypoint confidence (and the backend switching
 * between ViTPose and YOLO keypoints, which are calibrated differently)
 * pushed it back and forth across 0.5, and every run of misses longer than
 * ARM_GRACE_SEC in owl.ts sent the owl away and back in again from the
 * corner. */
export const OWL_ARM_GATES = {
  ACQUIRE: { minVis: 0.5, maxAngleDeg: 30 },
  KEEP: { minVis: 0.3, maxAngleDeg: 45 },
} as const

export type ArmCheck =
  | { ok: true; arm: ArmPose & { vis: number } }
  | { ok: false; reason: string }

/** Whether one named arm is in the pose the owl lands on, and where - or
 * which gate it failed, for armDebug.
 *
 * `vis` is the weaker of the elbow and wrist confidences - used to pick
 * between arms when both qualify. `pose` is in pixels (see convertPoint).
 */
export function checkOwlArm(
  pose: NormalizedLandmarkList,
  side: ArmSide,
  keep = false,
): ArmCheck {
  const gate = keep ? OWL_ARM_GATES.KEEP : OWL_ARM_GATES.ACQUIRE
  const elbow = side === 'left' ? pose[13] : pose[14]
  const wrist = side === 'left' ? pose[15] : pose[16]
  if (!elbow || !wrist) return { ok: false, reason: 'missing' }
  const vis = Math.min(elbow.visibility ?? 1, wrist.visibility ?? 1)
  if (vis <= gate.minVis) return { ok: false, reason: `vis=${vis.toFixed(2)}` }
  if (!(elbow.y > 0)) return { ok: false, reason: 'elbowAboveFrame' }
  const angle = Math.atan((wrist.y - elbow.y) / (wrist.x - elbow.x))
  if (!(Math.abs(angle) < gate.maxAngleDeg * (Math.PI / 180))) {
    return { ok: false, reason: `angle=${((angle * 180) / Math.PI).toFixed(0)}` }
  }
  const length = ((wrist.y - elbow.y) ** 2 + (wrist.x - elbow.x) ** 2) ** 0.5
  return { ok: true, arm: { x: elbow.x, y: elbow.y, angle, length, vis } }
}

// TODO: should this function be even more pure?
// right now its the trigger for a very specific pose
/** Which arm the owl should land on, and where.
 *
 * `lockedSide`, if given, is tried FIRST and kept for as long as it still
 * qualifies, even when the other arm is more confidently tracked. Without it
 * the choice was a hard left-then-right preference re-decided every frame, so
 * an idle arm that happened to drift within 30 degrees of horizontal stole the
 * owl from the arm actually being held out - and gave it back the next frame.
 * The owl visibly hopped between arms.
 *
 * That got worse once the ViTPose box format was corrected: with the old
 * distorted keypoints an idle arm usually failed the gates outright, so it
 * could not compete. Accurate keypoints let it qualify, which exposed the
 * missing lock rather than causing it. bat.ts has carried the same lock for a
 * while (see getForearmTarget) - this is that pattern, applied to the owl.
 *
 * Only falls back to picking between arms once the locked side genuinely
 * stops qualifying: arm lowered, bent, or turned away. The locked side is
 * judged against OWL_ARM_GATES.KEEP, everything else against ACQUIRE.
 *
 * `diag`, if given, is filled with each side's gate outcome for armDebug.
 */
export function calculateArmFromPose(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
  lockedSide?: ArmSide,
  diag?: Partial<Record<ArmSide, string>>,
): [ArmSide | undefined, ArmPose | undefined] {
  // mediapipe will predict even pose outside of frame, so its either 0 or all the points
  if (pose.length == 0) {
    if (diag) diag.left = diag.right = 'noPose'
    return [undefined, undefined]
  }
  const px = pose.map((point) => convertPoint(point, height, width))

  const strip = (a: ArmPose & { vis: number }): ArmPose => ({
    x: a.x, y: a.y, angle: a.angle, length: a.length,
  })
  const evaluate = (side: ArmSide, keep: boolean) => {
    const r = checkOwlArm(px, side, keep)
    const arm = r.ok && r.arm.y < height ? r.arm : undefined
    if (diag) diag[side] = arm ? 'ok' : r.ok ? 'belowFrame' : r.reason
    return arm
  }

  if (lockedSide) {
    const locked = evaluate(lockedSide, true)
    if (locked) return [lockedSide, strip(locked)]
  }

  // A locked side that just failed KEEP cannot pass the stricter ACQUIRE, so
  // it is not re-checked - which also keeps its KEEP failure in `diag`.
  const leftOk = lockedSide === 'left' ? undefined : evaluate('left', false)
  const rightOk = lockedSide === 'right' ? undefined : evaluate('right', false)
  if (!leftOk && !rightOk) return [undefined, undefined]
  if (!leftOk) return ['right', strip(rightOk!)]
  if (!rightOk) return ['left', strip(leftOk)]
  // Both qualify and nothing is locked yet: take the better-tracked one
  // rather than always the left, which was an arbitrary tie-break.
  return leftOk.vis >= rightOk.vis
    ? ['left', strip(leftOk)]
    : ['right', strip(rightOk)]
}

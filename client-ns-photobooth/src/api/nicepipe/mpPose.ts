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

/** Whether one named arm is in the pose the owl lands on, and where.
 *
 * `vis` is the weaker of the elbow and wrist confidences - used to pick
 * between arms when both qualify.
 */
function evaluateArm(
  pose: NormalizedLandmarkList,
  side: ArmSide,
): (ArmPose & { vis: number }) | undefined {
  const elbow = side === 'left' ? pose[13] : pose[14]
  const wrist = side === 'left' ? pose[15] : pose[16]
  if (!elbow || !wrist) return undefined
  const vis = Math.min(elbow.visibility ?? 1, wrist.visibility ?? 1)
  if (vis <= 0.5) return undefined
  if (!(elbow.y > 0)) return undefined
  const angle = Math.atan((wrist.y - elbow.y) / (wrist.x - elbow.x))
  if (!(Math.abs(angle) < 30 * (Math.PI / 180))) return undefined
  const length = ((wrist.y - elbow.y) ** 2 + (wrist.x - elbow.x) ** 2) ** 0.5
  return { x: elbow.x, y: elbow.y, angle, length, vis }
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
 * stops qualifying: arm lowered, bent, or turned away.
 */
export function calculateArmFromPose(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
  lockedSide?: ArmSide,
): [ArmSide | undefined, ArmPose | undefined] {
  // mediapipe will predict even pose outside of frame, so its either 0 or all the points
  if (pose.length == 0) return [undefined, undefined]
  const px = pose.map((point) => convertPoint(point, height, width))

  const strip = (a: ArmPose & { vis: number }): ArmPose => ({
    x: a.x, y: a.y, angle: a.angle, length: a.length,
  })

  if (lockedSide) {
    const locked = evaluateArm(px, lockedSide)
    if (locked && locked.y < height) return [lockedSide, strip(locked)]
  }

  const left = evaluateArm(px, 'left')
  const right = evaluateArm(px, 'right')
  const leftOk = left && left.y < height ? left : undefined
  const rightOk = right && right.y < height ? right : undefined
  if (!leftOk && !rightOk) return [undefined, undefined]
  if (!leftOk) return ['right', strip(rightOk!)]
  if (!rightOk) return ['left', strip(leftOk)]
  // Both qualify and nothing is locked yet: take the better-tracked one
  // rather than always the left, which was an arbitrary tie-break.
  return leftOk.vis >= rightOk.vis
    ? ['left', strip(leftOk)]
    : ['right', strip(rightOk)]
}

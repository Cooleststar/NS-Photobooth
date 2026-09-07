import { NormalizedLandmarkList } from '../../api/landmarks'

// Landmark indices - same MediaPipe-33 layout calculateArmFromPose already
// reads from (see api/nicepipe/mpPose.ts): wrists at 15/16, shoulders at
// 11/12, hips at 23/24. Shoulders+hips give a per-person torso-height
// estimate ("bodyScale") so the amplitude threshold below scales with how
// close someone is standing to the camera, instead of a fixed pixel/coord
// distance that would be too strict up close and too loose far away.
const LEFT_WRIST = 15
const RIGHT_WRIST = 16
const LEFT_SHOULDER = 11
const RIGHT_SHOULDER = 12
const LEFT_HIP = 23
const RIGHT_HIP = 24

const SMOOTHING_ALPHA = 0.35
// Below this much y-change, treat it as sensor noise rather than a real
// direction reversal - the raw landmark stream jitters even when a wrist is
// held still.
const NOISE_DEADBAND = 0.0005
// Minimum stroke amplitude, as a fraction of bodyScale, to count as a rep at
// all - keeps a tiny twitch from counting the same as a real arm-flap. Every
// rep that clears this scores exactly 1 point regardless of how far past it
// the stroke went - no partial credit for bigger flaps.
// Lowered from 0.15 so a shorter, faster flap (not full range of motion)
// still registers - raise this back up if it starts triggering on noise/
// incidental movement instead of a deliberate flap.
const LOW_RELATIVE_AMPLITUDE = 0.08
// Minimum time between counted reps per arm - a real flap can't reverse
// direction faster than this, so anything quicker is the smoothed signal
// oscillating around the noise floor rather than a second stroke.
const COOLDOWN_MS = 200

type Direction = 'up' | 'down'

interface SideState {
  smoothed: number | undefined
  direction: Direction
  extremeY: number
  lastRepTs: number
}

function createSideState(): SideState {
  return { smoothed: undefined, direction: 'down', extremeY: 0, lastRepTs: 0 }
}

function pointsToScale(pose: NormalizedLandmarkList): number | undefined {
  const ls = pose[LEFT_SHOULDER]
  const rs = pose[RIGHT_SHOULDER]
  const lh = pose[LEFT_HIP]
  const rh = pose[RIGHT_HIP]
  if (!ls || !rs || !lh || !rh) return undefined
  if ((ls.visibility ?? 0) < 0.5 || (rs.visibility ?? 0) < 0.5) return undefined
  const shoulderY = (ls.y + rs.y) / 2
  const hipY = (lh.y + rh.y) / 2
  const torso = Math.abs(hipY - shoulderY)
  return torso > 0.02 ? torso : undefined
}

/** Award only on a down -> up reversal (each upward stroke = one rep) - a
 * full flap has both a down and an up half, but counting both would double
 * every rep, so only the "recovery" half is scored. */
function processSide(
  state: SideState,
  rawY: number,
  visibility: number,
  bodyScale: number,
  nowMs: number,
): number {
  if (visibility < 0.5) return 0

  const prevSmoothed = state.smoothed
  const smoothed =
    prevSmoothed === undefined
      ? rawY
      : SMOOTHING_ALPHA * rawY + (1 - SMOOTHING_ALPHA) * prevSmoothed
  state.smoothed = smoothed

  if (prevSmoothed === undefined) {
    state.extremeY = smoothed
    return 0
  }

  const delta = smoothed - prevSmoothed
  if (Math.abs(delta) < NOISE_DEADBAND) return 0

  // Note: image y grows downward, so "up" (rising arm) is decreasing y.
  const newDirection: Direction = delta < 0 ? 'up' : 'down'
  if (newDirection === state.direction) return 0

  // Direction just reversed - extremeY was wherever the PREVIOUS stroke
  // ended, so the distance from there to here is that stroke's amplitude.
  const amplitude = Math.abs(smoothed - state.extremeY)
  const reversedIntoUp = newDirection === 'up'
  state.direction = newDirection
  state.extremeY = smoothed

  if (!reversedIntoUp) return 0 // only down -> up counts
  if (nowMs - state.lastRepTs < COOLDOWN_MS) return 0

  const relativeAmplitude = amplitude / bodyScale
  if (relativeAmplitude < LOW_RELATIVE_AMPLITUDE) return 0

  state.lastRepTs = nowMs
  return 1
}

export function createRepCounter() {
  let left = createSideState()
  let right = createSideState()

  return {
    reset() {
      left = createSideState()
      right = createSideState()
    },
    /** Points scored this frame (0 if no rep completed), summed across both
     * arms - processes whichever wrists are currently visible in `pose`. */
    processFrame(pose: NormalizedLandmarkList | undefined, nowMs: number): number {
      if (!pose || pose.length === 0) return 0
      const bodyScale = pointsToScale(pose)
      if (bodyScale === undefined) return 0

      const lw = pose[LEFT_WRIST]
      const rw = pose[RIGHT_WRIST]
      let points = 0
      if (lw) points += processSide(left, lw.y, lw.visibility ?? 0, bodyScale, nowMs)
      if (rw) points += processSide(right, rw.y, rw.visibility ?? 0, bodyScale, nowMs)
      return points
    },
  }
}

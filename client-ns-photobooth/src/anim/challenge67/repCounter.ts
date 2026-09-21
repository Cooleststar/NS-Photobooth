import { NormalizedLandmarkList } from '../../api/landmarks'

// Landmark indices - same MediaPipe-33 layout calculateArmFromPose already
// reads from (see api/nicepipe/mpPose.ts): wrists at 15/16, elbows at 13/14,
// shoulders at 11/12, hips at 23/24. Shoulders+hips give a per-person
// torso-height estimate ("bodyScale") so the amplitude threshold below scales
// with how close someone is standing to the camera, instead of a fixed
// pixel/coord distance that would be too strict up close and too loose far
// away. The wrist is what's actually tracked for reps; the elbow only
// qualifies a stroke after the fact - see MAX_ELBOW_TRAVEL_RATIO.
const LEFT_WRIST = 15
const RIGHT_WRIST = 16
const LEFT_ELBOW = 13
const RIGHT_ELBOW = 14
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
// Lowered from 0.15 to 0.08 so a shorter, faster flap (not full range of
// motion) still registers, then to 0.05 on request to make scoring a point
// easier still - raise this back up if it starts triggering on noise/
// incidental movement instead of a deliberate flap.
const LOW_RELATIVE_AMPLITUDE = 0.05
// Minimum time between counted reps per arm - a real flap can't reverse
// direction faster than this, so anything quicker is the smoothed signal
// oscillating around the noise floor rather than a second stroke.
const COOLDOWN_MS = 200
// How far the elbow may travel during a stroke, as a fraction of how far the
// wrist travelled, before the stroke stops looking like a flap.
//
// A real 67 flap pivots the forearm about a roughly planted elbow: the wrist
// swings through an arc while the elbow barely moves, so this ratio comes out
// near zero. Movement that ISN'T a flap moves both together - someone walking
// or swaying, the torso bobbing, or an arm swung from the shoulder - and the
// elbow then travels a sizeable fraction of what the wrist does (for a pure
// shoulder pivot it's ~50%, the elbow sitting about halfway along the arm).
// So this rejects whole-arm and whole-body motion without caring what angle
// any individual person holds their arm at, which an absolute elbow-angle
// range would have had to be tuned for per person.
//
// Deliberately permissive at 0.6, just past that ~50% shoulder-pivot case:
// the amplitude threshold above was lowered twice to make scoring EASIER, so
// a new gate that starts out strict would undo that. Lower it toward ~0.4 to
// reject more aggressively if incidental movement still scores; raise it (or
// set it above 1) to effectively disable the gate.
const MAX_ELBOW_TRAVEL_RATIO = 0.6

type Direction = 'up' | 'down'

interface SideState {
  smoothed: number | undefined
  direction: Direction
  extremeY: number
  /** Smoothed elbow y, tracked purely so the gate above can compare like
   * with like - an unsmoothed elbow against a smoothed wrist would charge
   * the elbow for jitter the wrist has already had filtered out, and at the
   * minimum scoring amplitude that jitter is a real fraction of the ratio. */
  smoothedElbow: number | undefined
  /** Where the elbow was when the current stroke started, i.e. captured at
   * the same reversal that set extremeY. undefined when the elbow wasn't
   * visible then - see the fail-open note in processSide. */
  extremeElbowY: number | undefined
  lastRepTs: number
}

function createSideState(): SideState {
  return {
    smoothed: undefined,
    direction: 'down',
    extremeY: 0,
    smoothedElbow: undefined,
    extremeElbowY: undefined,
    lastRepTs: 0,
  }
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
  rawElbowY: number | undefined,
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

  // Same filter as the wrist, so the two are directly comparable below. A
  // missing elbow resets rather than holds the last value: a stale position
  // from before it was occluded would read as "the elbow stayed put" and
  // wave through exactly the whole-body movement this is meant to catch.
  const prevSmoothedElbow = state.smoothedElbow
  const smoothedElbow =
    rawElbowY === undefined
      ? undefined
      : prevSmoothedElbow === undefined
        ? rawElbowY
        : SMOOTHING_ALPHA * rawElbowY + (1 - SMOOTHING_ALPHA) * prevSmoothedElbow
  state.smoothedElbow = smoothedElbow

  if (prevSmoothed === undefined) {
    state.extremeY = smoothed
    state.extremeElbowY = smoothedElbow
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
  const strokeStartElbowY = state.extremeElbowY
  const reversedIntoUp = newDirection === 'up'
  state.direction = newDirection
  state.extremeY = smoothed
  state.extremeElbowY = smoothedElbow

  if (!reversedIntoUp) return 0 // only down -> up counts
  if (nowMs - state.lastRepTs < COOLDOWN_MS) return 0

  const relativeAmplitude = amplitude / bodyScale
  if (relativeAmplitude < LOW_RELATIVE_AMPLITUDE) return 0

  // Arm gate - see MAX_ELBOW_TRAVEL_RATIO. Fails OPEN: with the elbow not
  // visible at one or both ends of the stroke there's nothing to compare,
  // and rejecting on that basis would cost reps precisely where tracking is
  // already weakest, which is the opposite of an accuracy improvement.
  if (smoothedElbow !== undefined && strokeStartElbowY !== undefined && amplitude > 0) {
    const elbowTravel = Math.abs(smoothedElbow - strokeStartElbowY)
    if (elbowTravel / amplitude > MAX_ELBOW_TRAVEL_RATIO) return 0
  }

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

      // Held to the same visibility bar the wrist is - a low-confidence
      // elbow is a guess at where the elbow might be, and feeding that into
      // the travel ratio would gate real reps on noise. undefined instead,
      // which the gate treats as "don't judge this stroke".
      const elbowY = (i: number) => {
        const lm = pose[i]
        return lm && (lm.visibility ?? 0) >= 0.5 ? lm.y : undefined
      }

      const lw = pose[LEFT_WRIST]
      const rw = pose[RIGHT_WRIST]
      let points = 0
      if (lw) {
        points += processSide(left, lw.y, lw.visibility ?? 0, elbowY(LEFT_ELBOW), bodyScale, nowMs)
      }
      if (rw) {
        points += processSide(right, rw.y, rw.visibility ?? 0, elbowY(RIGHT_ELBOW), bodyScale, nowMs)
      }
      return points
    },
  }
}

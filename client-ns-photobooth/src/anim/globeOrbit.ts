// The globe's orbit timing, split out of globe.ts so it can be tested without
// PIXI or the gif asset that file imports. Pure: angle and time in, angle and
// opacity out. Same pattern as globePose.ts.

/** Base angular speed of the orbit, radians per second. */
export const ORBIT_SPEED = 0.8

// Depth at which the globe has faded out completely. sin(angle) is the depth
// cue (+1 nearest the camera, -1 furthest). It starts fading as it crosses
// the side of the body (depth 0), is fully gone by this much depth, and stays
// gone across the deepest part of the pass before easing back in on the other
// side.
//
// There's no person-segmentation mask in this pipeline, so "behind the body"
// has to be sold with opacity rather than real occlusion. This replaced a
// hard cut at a fixed angle followed by a timed absence, which read as the
// globe blinking out rather than travelling anywhere.
//
// Don't raise this to shorten the time the globe is gone - that was tried on
// paper: it barely shortens the gap and leaves the globe as a faint ghost
// drifting across the head. BEHIND_SPEED_BOOST is the knob for that.
export const BEHIND_FADE_DEPTH = 0.55

// How much faster the orbit travels while the globe is hidden behind the
// body. At a constant speed it was gone for ~2.6s of every 7.9s lap, which
// read as the globe having left rather than gone round. The boost is weighted
// by (1 - opacity)^2, so the orbit is at its normal speed whenever the globe
// is fully visible - the front pass is unchanged - and only gets near full
// boost once it is almost invisible, where the speed-up can't be seen.
//
// Simulated at 2.5: fully invisible ~1.0s (was 2.6), gap from starting to
// fade until fully back ~1.9s (was 3.8), lap 5.95s, front pass 4.04s as
// before. 2 gives ~1.3s invisible, 3 ~0.9s.
export const BEHIND_SPEED_BOOST = 2.5

// A frame hitch (GC, gif decode, a stalled capture card) hands the ticker one
// huge delta. At boosted speed that could carry the globe from hidden straight
// to fully visible in a single frame - a pop. The orbit simply loses whatever
// time is beyond this instead, and whatever is left is integrated in short
// substeps, since the speed changes along the way.
const MAX_ORBIT_DT = 0.1
const MAX_SUBSTEP = 1 / 30

const TWO_PI = Math.PI * 2
const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

/** The globe's orbit opacity at `angle`: 1 across the front, smoothstepped to
 * 0 between depth 0 and -BEHIND_FADE_DEPTH. A bare linear fade leaves a
 * visible corner where it meets full opacity and full transparency. */
export function orbitAlpha(angle: number) {
  const t = clamp01((Math.sin(angle) + BEHIND_FADE_DEPTH) / BEHIND_FADE_DEPTH)
  return t * t * (3 - 2 * t)
}

/** Angular speed at `angle`, radians per second - ORBIT_SPEED while
 * visible, rising to ORBIT_SPEED * BEHIND_SPEED_BOOST while hidden. Taken
 * from the orbit's own depth, never from the sprite's alpha: a hands blend
 * pushes that toward 1 and would cancel the boost. */
export function orbitSpeed(angle: number) {
  const hidden = 1 - orbitAlpha(angle)
  return ORBIT_SPEED * (1 + (BEHIND_SPEED_BOOST - 1) * hidden * hidden)
}

/** Advance the orbit by `dt` seconds. Returns an angle in [0, 2pi). */
export function stepOrbitAngle(angle: number, dt: number) {
  let left = Math.min(Math.max(0, dt), MAX_ORBIT_DT)
  while (left > 0) {
    const h = Math.min(left, MAX_SUBSTEP)
    angle += orbitSpeed(angle) * h
    left -= h
  }
  return ((angle % TWO_PI) + TWO_PI) % TWO_PI
}

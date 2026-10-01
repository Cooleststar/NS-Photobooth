// The perched bat's idle animation, split out of bat.ts so it can be tested
// without PIXI or the gif assets that file imports. Pure: elapsed time in,
// Bat.gif frame index out.
//
// There is no dedicated "perched" art for the bat — every frame of Bat.gif,
// bat_swoop.gif and bat_vanish.gif is mid-flight (the old rest asset,
// Bat_rest2.gif, was a different character entirely: a caped cat). So the
// perch is built from Bat.gif's own frames instead, which keeps it the very
// same bat that flew in: it settles from the swoop's last pose (wings up) into
// the wings-down part of the flap, idles slowly around there, and every few
// seconds does one full flap so it reads as alive rather than a frozen sticker.

/** Bat.gif plays each of its 10 frames for 40ms. */
export const FLY_FRAME_MS = 40

/** bat_swoop.gif ends on Bat.gif's frame 0 (wings up), so the perch picks up
 * from there and lets the wings come down onto the arm — no visible cut. */
export const PERCH_SETTLE_FRAMES = [0, 1, 2, 3, 4, 5, 6, 7]
/** Frames 6-8 are the bottom of the downstroke: wings low, body upright and
 * compact — the closest thing in the flap to a resting pose. Cycled slowly
 * rather than flapped, for a gentle "breathing" shift of the wings. */
export const PERCH_IDLE_FRAMES = [7, 6, 7, 8]
export const PERCH_IDLE_STEP_MS = 300
/** One whole flap at native speed, starting and ending in the idle pose. */
export const PERCH_FLUTTER_FRAMES = [8, 9, 0, 1, 2, 3, 4, 5, 6, 7]

/** First flutter at a fixed delay so every landing (and every exported gif of
 * one) behaves the same; later ones are jittered so a long perch doesn't look
 * mechanical. Seconds. */
export const PERCH_FIRST_FLUTTER_S = 2.5
export const PERCH_FLUTTER_MIN_S = 3
export const PERCH_FLUTTER_MAX_S = 6

/** Slow sine "breathing" applied on top of the frames, in seconds. */
export const PERCH_BOB_PERIOD_S = 2.4

export type PerchPhase = 'settle' | 'idle' | 'flutter'
export interface PerchState {
  phase: PerchPhase
  /** seconds since the current phase began */
  phaseT: number
  /** seconds since the perch began, for the bob */
  t: number
  /** idle seconds until the next flutter */
  nextFlutter: number
}

export const createPerchState = (): PerchState => ({
  phase: 'settle',
  phaseT: 0,
  t: 0,
  nextFlutter: PERCH_FIRST_FLUTTER_S,
})

const settleDuration = (PERCH_SETTLE_FRAMES.length * FLY_FRAME_MS) / 1000
const flutterDuration = (PERCH_FLUTTER_FRAMES.length * FLY_FRAME_MS) / 1000

/** advances `s` by `dt` seconds, returning the Bat.gif frame to show. */
export function stepPerch(s: PerchState, dt: number, rng: () => number = Math.random): number {
  s.t += dt
  s.phaseT += dt
  if (s.phase === 'settle' && s.phaseT >= settleDuration) {
    s.phase = 'idle'
    s.phaseT -= settleDuration
  }
  if (s.phase === 'idle' && s.phaseT >= s.nextFlutter) {
    s.phase = 'flutter'
    s.phaseT -= s.nextFlutter
  }
  if (s.phase === 'flutter' && s.phaseT >= flutterDuration) {
    s.phase = 'idle'
    s.phaseT -= flutterDuration
    s.nextFlutter =
      PERCH_FLUTTER_MIN_S + rng() * (PERCH_FLUTTER_MAX_S - PERCH_FLUTTER_MIN_S)
  }
  return perchFrame(s)
}

export function perchFrame(s: PerchState): number {
  const ms = s.phaseT * 1000
  switch (s.phase) {
    case 'settle':
      return PERCH_SETTLE_FRAMES[Math.min(PERCH_SETTLE_FRAMES.length - 1, Math.floor(ms / FLY_FRAME_MS))]
    case 'flutter':
      return PERCH_FLUTTER_FRAMES[Math.min(PERCH_FLUTTER_FRAMES.length - 1, Math.floor(ms / FLY_FRAME_MS))]
    case 'idle':
      return PERCH_IDLE_FRAMES[Math.floor(ms / PERCH_IDLE_STEP_MS) % PERCH_IDLE_FRAMES.length]
  }
}

/** 0 at the start of the settle, 1 once it is done — for easing the sprite
 * from the swoop's position onto the arm, and fading the bob in. */
export const perchSettleProgress = (s: PerchState) =>
  s.phase === 'settle' ? Math.min(1, s.phaseT / settleDuration) : 1

/** -1..1 breathing wave, faded in over the settle so it doesn't jump. */
export const perchBob = (s: PerchState) =>
  Math.sin((s.t / PERCH_BOB_PERIOD_S) * Math.PI * 2) * perchSettleProgress(s)

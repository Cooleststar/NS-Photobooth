// The perched bat's idle timing, split out of bat.ts so it can be tested
// without PIXI or the image assets that file imports. Pure: elapsed time in,
// phase and 0..1 animation values out.
//
// The perched bat is its own art (bat_perch.png: upright, front-facing, wings
// spread, feet on the arm) rather than frames of the flight gif. It used to be
// built from Bat.gif's downstroke - every frame of Bat.gif, bat_swoop.gif and
// bat_vanish.gif is mid-flight and side-on - which left it hovering over the
// arm with its body horizontal. Being a single still, it is kept alive by
// motion applied in bat.ts: a short blend in from the swoop, a slow breathing
// bob, and every few seconds a brief stretch of the wings.

/** How long the swoop (side-on) takes to cross-fade into the perch (front-on),
 * and back again on lift-off. Seconds. */
export const PERCH_BLEND_S = 0.25

/** First wing stretch at a fixed delay so every landing behaves the same;
 * later ones are jittered so a long perch doesn't look mechanical. Seconds. */
export const PERCH_FIRST_FLUTTER_S = 2.5
export const PERCH_FLUTTER_MIN_S = 3
export const PERCH_FLUTTER_MAX_S = 6
/** How long one wing stretch lasts, in seconds. */
export const PERCH_FLUTTER_S = 0.5

/** Slow sine "breathing" applied on top of the art, in seconds. */
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

/** advances `s` by `dt` seconds, returning the phase it is now in. */
export function stepPerch(s: PerchState, dt: number, rng: () => number = Math.random): PerchPhase {
  s.t += dt
  s.phaseT += dt
  if (s.phase === 'settle' && s.phaseT >= PERCH_BLEND_S) {
    s.phase = 'idle'
    s.phaseT -= PERCH_BLEND_S
  }
  if (s.phase === 'idle' && s.phaseT >= s.nextFlutter) {
    s.phase = 'flutter'
    s.phaseT -= s.nextFlutter
  }
  if (s.phase === 'flutter' && s.phaseT >= PERCH_FLUTTER_S) {
    s.phase = 'idle'
    s.phaseT -= PERCH_FLUTTER_S
    s.nextFlutter =
      PERCH_FLUTTER_MIN_S + rng() * (PERCH_FLUTTER_MAX_S - PERCH_FLUTTER_MIN_S)
  }
  return s.phase
}

/** 0 at the start of the settle, 1 once it is done — drives the blend from
 * the swoop onto the arm, and fades the bob in. */
export const perchSettleProgress = (s: PerchState) =>
  s.phase === 'settle' ? Math.min(1, s.phaseT / PERCH_BLEND_S) : 1

/** -1..1 breathing wave, faded in over the settle so it doesn't jump. */
export const perchBob = (s: PerchState) =>
  Math.sin((s.t / PERCH_BOB_PERIOD_S) * Math.PI * 2) * perchSettleProgress(s)

/** 0..1..0 over one flutter, 0 the rest of the time — how far the wings are
 * stretched out beyond their resting spread. */
export const perchWingStretch = (s: PerchState) =>
  s.phase === 'flutter' ? Math.sin(Math.min(1, s.phaseT / PERCH_FLUTTER_S) * Math.PI) : 0

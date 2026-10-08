// The caped cat's run motion, split out of capecat.ts so it can be tested
// without PIXI or the gif asset that file imports. Pure: time in, pose out.
//
// The cat has no running clip - Bat_rest2.gif is a standing idle loop - so
// the run is sold in code: it travels along an ease-out path, hopping, with
// a squash each time it touches down. capecat.ts plays the gif faster and
// faces the sprite the way it is travelling on top of this.

/** Hops over a whole run. */
export const RUN_HOPS = 3
/** Hop height at the start of a run, in multiples of the cat's size. Shrinks
 * to nothing by the end, so the cat settles onto the arm rather than landing
 * mid-bounce. */
export const HOP_HEIGHT = 0.18
/** How much the cat squashes on touching down: its height dips by this
 * fraction (and its width bulges by half of it). */
export const SQUASH = 0.12

export interface RunFrame {
  /** 0 at the start of the path, 1 at its end - eased out */
  progress: number
  /** how far above the path the cat is, in multiples of its size (>= 0) */
  hop: number
  /** 0 mid-air, up to SQUASH at the moment of touching down */
  squash: number
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

/** Where the cat is `t` seconds into a run lasting `duration` seconds. */
export function runFrame(t: number, duration: number): RunFrame {
  const linear = duration > 0 ? clamp01(t / duration) : 1
  // Same ease-out the owl and bat fly in with (lerpEO, power 1.5).
  const progress = 1 - (1 - linear) ** 1.5
  // |sin| gives RUN_HOPS arches over the run; zero at both ends.
  const arch = Math.abs(Math.sin(Math.PI * RUN_HOPS * linear))
  const hop = arch * HOP_HEIGHT * (1 - linear)
  // Only near each touchdown (arch close to 0). Not at take-off - the cat
  // starts from standing, and a crouch there pops for a frame or two, which
  // shows when it runs off the arm - and tapering to nothing at the end, so
  // it hands over without a jump to the arrival settle in capecat.ts.
  const contact = Math.max(0, 1 - arch * 4)
  const squash = linear > 0.5 / RUN_HOPS ? SQUASH * contact * (1 - linear ** 2) : 0
  return { progress, hop, squash }
}
